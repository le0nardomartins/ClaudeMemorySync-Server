// Histórico de versões no Postgres da Railway.
//
//   blobs            um registro por CONTEÚDO (sha256), compactado (deflate-raw).
//                    Arquivo igual em vários caminhos ou em várias versões é
//                    guardado uma vez só.
//   memory_versions  uma linha por versão, com o manifesto compactado
//                    (caminho -> sha256/size/mtime). Só as MAX_VERSIONS mais
//                    novas são mantidas; blob que nenhuma delas usa é apagado.

const { Pool } = require("pg");
const { readPackage } = require("./zip");
const { deflate, inflate, isExcluded, manifestObject, parseManifest, sha256, MAX_UNCOMPRESSED } = require("./bundle");
const { mergeManifests, sameContent } = require("./versions");

const MAX_VERSIONS = 3;
const MAX_MANIFEST = 5 * 1024 * 1024;

class MissingBlobs extends Error {
  constructor(missing) {
    super(`faltam ${missing.length} arquivo(s) no envio`);
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

const readManifest = (buf) => parseManifest(JSON.parse(inflate(buf, MAX_MANIFEST).toString("utf-8")));

async function insertBlobs(db, blobs) {
  // blobs: [[sha, size, dados compactados]]; ON CONFLICT: outro caminho já trouxe o mesmo conteúdo
  for (const [sha, size, data] of blobs) {
    await db.query("INSERT INTO blobs (sha256, size, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [sha, size, data]);
  }
}

// Apaga versões além de MAX_VERSIONS e os blobs que nenhuma versão restante usa
async function prune(db) {
  await db.query(
    `DELETE FROM memory_versions
      WHERE id NOT IN (SELECT id FROM memory_versions ORDER BY id DESC LIMIT $1)`,
    [MAX_VERSIONS]
  );
  const { rows } = await db.query("SELECT manifest FROM memory_versions");
  const used = new Set();
  for (const r of rows) for (const m of readManifest(r.manifest).values()) used.add(m.sha256);
  const res = await db.query("DELETE FROM blobs WHERE NOT (sha256 = ANY($1::text[]))", [[...used]]);
  return res.rowCount;
}

// Converte as versões do formato antigo (zip inteiro na coluna package)
async function migrateZipVersions(pool) {
  const { rows: cols } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'memory_versions' AND column_name = 'package'`
  );
  if (!cols.length) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query("LOCK TABLE memory_versions IN EXCLUSIVE MODE");
    await client.query("DELETE FROM memory_versions WHERE package IS NULL AND manifest IS NULL");
    // Só as versões que vão sobrar: não vale converter o que seria apagado
    await client.query(
      `DELETE FROM memory_versions
        WHERE id NOT IN (SELECT id FROM memory_versions ORDER BY id DESC LIMIT $1)`,
      [MAX_VERSIONS]
    );
    const { rows: ids } = await client.query("SELECT id FROM memory_versions WHERE manifest IS NULL ORDER BY id");
    const stored = new Set();
    for (const { id } of ids) {
      const { rows } = await client.query("SELECT package FROM memory_versions WHERE id = $1", [id]);
      const files = new Map();
      const blobs = [];
      for (const [path, f] of readPackage(rows[0].package)) {
        if (isExcluded(path)) continue;
        const sha = sha256(f.content);
        files.set(path, { sha256: sha, size: f.content.length, mtime: f.mtime });
        if (!stored.has(sha)) {
          stored.add(sha);
          blobs.push([sha, f.content.length, deflate(f.content)]);
        }
      }
      await insertBlobs(client, blobs);
      const manifest = deflate(Buffer.from(JSON.stringify(manifestObject(files, Number(id)))));
      let total = 0;
      for (const m of files.values()) total += m.size;
      await client.query("UPDATE memory_versions SET manifest = $1, file_count = $2, total_bytes = $3 WHERE id = $4", [
        manifest,
        files.size,
        total,
        id,
      ]);
    }
    await client.query("ALTER TABLE memory_versions DROP COLUMN package, DROP COLUMN IF EXISTS package_bytes");
    await client.query("COMMIT");
    console.log(`[migração] ${ids.length} versão(ões) convertidas de zip para manifesto + blobs`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // DROP COLUMN não devolve o espaço em disco; VACUUM FULL reescreve a tabela sem os zips
  await pool.query("VACUUM FULL memory_versions");
  return true;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blobs (
      sha256 TEXT   PRIMARY KEY,
      size   BIGINT NOT NULL,
      data   BYTEA  NOT NULL
    );
    -- Já vem compactado: não adianta o Postgres tentar comprimir de novo
    ALTER TABLE blobs ALTER COLUMN data SET STORAGE EXTERNAL;
    CREATE TABLE IF NOT EXISTS memory_versions (
      id            BIGSERIAL PRIMARY KEY,
      client_id     TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      file_count    INTEGER     NOT NULL,
      total_bytes   BIGINT      NOT NULL
    );
    ALTER TABLE memory_versions ADD COLUMN IF NOT EXISTS manifest BYTEA;
  `);
  await migrateZipVersions(pool);
  await pool.query("DELETE FROM memory_versions WHERE manifest IS NULL");
  await prune(pool);
}

async function latestId(db) {
  const { rows } = await db.query("SELECT id FROM memory_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? Number(rows[0].id) : null;
}

// upload: { files: Map(path -> meta), blobs: Map(sha -> dados compactados) } (bundle.readUpload).
// Roda dentro da transação, com lock, para dois PCs enviando ao mesmo tempo
// não perderem mudanças um do outro. Lança MissingBlobs se o PC não mandou
// conteúdo que o server também não tem.
async function saveVersion(pool, clientId, upload) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE memory_versions IN EXCLUSIVE MODE");

    const needed = [...new Set([...upload.files.values()].map((m) => m.sha256))].filter((s) => !upload.blobs.has(s));
    const { rows: have } = await client.query("SELECT sha256 FROM blobs WHERE sha256 = ANY($1::text[])", [needed]);
    const inDb = new Set(have.map((r) => r.sha256));
    const missing = needed.filter((s) => !inDb.has(s));
    if (missing.length) throw new MissingBlobs(missing);

    const prevRow = await client.query("SELECT id, manifest FROM memory_versions ORDER BY id DESC LIMIT 1");
    const prev = prevRow.rows.length ? readManifest(prevRow.rows[0].manifest) : new Map();

    const load = async (sha) => {
      if (upload.blobs.has(sha)) return inflate(upload.blobs.get(sha), MAX_UNCOMPRESSED);
      const { rows } = await client.query("SELECT data FROM blobs WHERE sha256 = $1", [sha]);
      return inflate(rows[0].data, MAX_UNCOMPRESSED);
    };
    const { files, created } = await mergeManifests(prev, upload.files, load);
    let totalBytes = 0;
    for (const m of files.values()) totalBytes += m.size;

    // Nada mudou de conteúdo: não cria versão (os outros PCs não teriam o que baixar)
    if (prevRow.rows.length && sameContent(files, prev)) {
      await client.query("COMMIT");
      return { versionId: Number(prevRow.rows[0].id), fileCount: files.size, totalBytes, newBytes: 0, unchanged: true };
    }

    // Só entra o que a versão nova usa (o upload pode trazer conteúdo que o merge descartou)
    const sizeOf = new Map([...files.values()].map((m) => [m.sha256, m.size]));
    const blobs = [];
    for (const [sha, data] of upload.blobs) if (sizeOf.has(sha)) blobs.push([sha, sizeOf.get(sha), data]);
    for (const [sha, content] of created) blobs.push([sha, content.length, deflate(content)]);
    await insertBlobs(client, blobs);

    const { rows } = await client.query("SELECT nextval(pg_get_serial_sequence('memory_versions', 'id')) AS id");
    const versionId = Number(rows[0].id);
    const manifest = deflate(Buffer.from(JSON.stringify(manifestObject(files, versionId))));
    await client.query(
      `INSERT INTO memory_versions (id, client_id, file_count, total_bytes, manifest)
       VALUES ($1, $2, $3, $4, $5)`,
      [versionId, clientId, files.size, totalBytes, manifest]
    );
    await prune(client);

    await client.query("COMMIT");
    const newBytes = blobs.reduce((sum, b) => sum + b[2].length, 0);
    return { versionId, fileCount: files.size, totalBytes, newBytes, unchanged: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Manifesto compactado da versão mais nova, repassado sem descompactar
async function loadLatestManifest(pool) {
  const { rows } = await pool.query("SELECT id, manifest FROM memory_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? { versionId: Number(rows[0].id), manifest: rows[0].manifest } : null;
}

// Conteúdos pedidos pelo PC, compactados como estão no banco
async function loadBlobs(pool, hashes) {
  const { rows } = await pool.query("SELECT sha256, data FROM blobs WHERE sha256 = ANY($1::text[])", [hashes]);
  return rows;
}

async function listVersions(pool) {
  const { rows } = await pool.query(
    `SELECT id, client_id, created_at, file_count, total_bytes, length(manifest) AS manifest_bytes
       FROM memory_versions ORDER BY id DESC`
  );
  const { rows: stats } = await pool.query("SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS bytes FROM blobs");
  return {
    blobs: { count: Number(stats[0].n), storedBytes: Number(stats[0].bytes) },
    versions: rows.map((r) => ({
      id: Number(r.id),
      clientId: r.client_id,
      createdAt: r.created_at,
      fileCount: r.file_count,
      totalBytes: Number(r.total_bytes),
      manifestBytes: Number(r.manifest_bytes),
    })),
  };
}

module.exports = {
  createPool,
  migrate,
  saveVersion,
  latestId,
  loadLatestManifest,
  loadBlobs,
  listVersions,
  MissingBlobs,
  MAX_VERSIONS,
};
