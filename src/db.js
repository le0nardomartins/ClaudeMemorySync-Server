// Armazém de versões no Postgres da Railway.
//
//   cms_blobs     um registro por conteúdo selado (id calculado no PC). O server não
//                 consegue ler: com SYNC_KEY, tudo chega cifrado.
//   cms_versions  uma linha por versão: manifesto selado + ids que ela usa (refs).
//                 Só as MAX_VERSIONS mais novas ficam; blob que nenhuma usa é apagado.
//
// Concorrência: um envio diz em qual versão se baseou. Se não for a mais nova,
// outro PC chegou antes: Conflict (409) e o PC refaz o merge em cima da nova.
// O número da versão é o "relógio" do sistema: define a ordem das mudanças.

const { Pool } = require("pg");

const MAX_VERSIONS = 3;

class Conflict extends Error {
  constructor(latest) {
    super("outro PC enviou antes: busque a versão nova e refaça o merge");
    this.latest = latest;
  }
}

class MissingBlobs extends Error {
  constructor(missing) {
    super(`faltam ${missing.length} blob(s) no envio`);
    this.missing = missing;
  }
}

// Aceita DATABASE_URL ou as variáveis PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
// (o driver pg lê essas sozinho quando não há connectionString).
function connectionConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const missing = ["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Defina DATABASE_URL ou ${missing.join(", ")}`);
  return {};
}

function createPool() {
  const pool = new Pool({
    ...connectionConfig(),
    // Pela rede interna da Railway (postgres.railway.internal) não precisa de SSL.
    // Pelo proxy público, defina DATABASE_SSL=true.
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Nenhuma consulta presa segura conexão/memória para sempre
    statement_timeout: 60000,
    idle_in_transaction_session_timeout: 60000,
  });
  // Erro em conexão ociosa (ex.: restart do Postgres) não pode derrubar o processo
  pool.on("error", (err) => console.error("[pg] conexão ociosa falhou:", err.message));
  return pool;
}

async function migrate(pool) {
  // Protocolos anteriores (merge no server, conteúdo legível): descartados. Os PCs
  // guardam a base localmente e reenviam tudo na primeira rodada com o cliente novo.
  const { rows } = await pool.query(
    "SELECT to_regclass('memory_versions') IS NOT NULL AS old_versions, to_regclass('blobs') IS NOT NULL AS old_blobs"
  );
  if (rows[0].old_versions || rows[0].old_blobs) {
    await pool.query("DROP TABLE IF EXISTS memory_versions; DROP TABLE IF EXISTS blobs");
    console.log("[migração] tabelas do protocolo antigo removidas; os PCs reenviam tudo na próxima rodada");
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cms_blobs (
      id         TEXT        PRIMARY KEY,
      data       BYTEA       NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Já vem compactado (e cifrado): não adianta o Postgres tentar comprimir
    ALTER TABLE cms_blobs ALTER COLUMN data SET STORAGE EXTERNAL;
    CREATE TABLE IF NOT EXISTS cms_versions (
      id          BIGINT      PRIMARY KEY,
      client_id   TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      manifest    BYTEA       NOT NULL,
      refs        TEXT[]      NOT NULL
    );
  `);
}

async function latestId(db) {
  const { rows } = await db.query("SELECT id FROM cms_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? Number(rows[0].id) : null;
}

// upload: bundle.readUpload. Lança Conflict se `base` não é a versão mais nova e
// MissingBlobs se alguma ref não veio no envio nem existe no banco.
async function saveVersion(pool, clientId, upload) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE cms_versions IN EXCLUSIVE MODE");

    const latest = await latestId(client);
    if (latest !== upload.base) throw new Conflict(latest);

    const needed = [...upload.refs].filter((id) => !upload.blobs.has(id));
    const { rows: have } = await client.query("SELECT id FROM cms_blobs WHERE id = ANY($1::text[])", [needed]);
    const inDb = new Set(have.map((r) => r.id));
    const missing = needed.filter((id) => !inDb.has(id));
    if (missing.length) throw new MissingBlobs(missing);

    let newBytes = 0;
    for (const [id, data] of upload.blobs) {
      const res = await client.query("INSERT INTO cms_blobs (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, data]);
      if (res.rowCount) newBytes += data.length;
    }
    await client.query("INSERT INTO cms_versions (id, client_id, manifest, refs) VALUES ($1, $2, $3, $4)", [
      upload.version,
      clientId,
      upload.manifest,
      [...upload.refs],
    ]);
    await client.query(
      `DELETE FROM cms_versions
        WHERE id NOT IN (SELECT id FROM cms_versions ORDER BY id DESC LIMIT $1)`,
      [MAX_VERSIONS]
    );
    const gc = await client.query(
      "DELETE FROM cms_blobs b WHERE NOT EXISTS (SELECT 1 FROM cms_versions v WHERE b.id = ANY(v.refs))"
    );

    await client.query("COMMIT");
    return { versionId: upload.version, refCount: upload.refs.size, newBytes, prunedBlobs: gc.rowCount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Manifesto selado da versão mais nova, repassado como está
async function loadLatest(pool) {
  const { rows } = await pool.query("SELECT id, manifest FROM cms_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? { versionId: Number(rows[0].id), manifest: rows[0].manifest } : null;
}

async function loadBlobs(pool, ids) {
  const { rows } = await pool.query("SELECT id, data FROM cms_blobs WHERE id = ANY($1::text[])", [ids]);
  return rows;
}

async function listVersions(pool) {
  const { rows } = await pool.query(
    `SELECT id, client_id, created_at, cardinality(refs) AS ref_count, length(manifest) AS manifest_bytes
       FROM cms_versions ORDER BY id DESC`
  );
  const { rows: stats } = await pool.query("SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS bytes FROM cms_blobs");
  return {
    blobs: { count: Number(stats[0].n), storedBytes: Number(stats[0].bytes) },
    versions: rows.map((r) => ({
      id: Number(r.id),
      clientId: r.client_id,
      createdAt: r.created_at,
      refs: r.ref_count,
      manifestBytes: Number(r.manifest_bytes),
    })),
  };
}

module.exports = {
  createPool,
  migrate,
  saveVersion,
  latestId,
  loadLatest,
  loadBlobs,
  listVersions,
  Conflict,
  MissingBlobs,
  MAX_VERSIONS,
};
