// Histórico de versões no Postgres da Railway.
// Cada envio vira uma linha em memory_versions com o pacote zip PRONTO (bytea,
// já compactado). O download só lê e repassa esses bytes. Só as MAX_VERSIONS
// mais novas são mantidas.

const { Pool } = require("pg");
const { buildPackage } = require("./zip");

const MAX_VERSIONS = 5;

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id            BIGSERIAL PRIMARY KEY,
      client_id     TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      file_count    INTEGER     NOT NULL,
      total_bytes   BIGINT      NOT NULL
    );
    ALTER TABLE memory_versions ADD COLUMN IF NOT EXISTS package       BYTEA;
    ALTER TABLE memory_versions ADD COLUMN IF NOT EXISTS package_bytes BIGINT;
    -- O pacote já é compactado: não adianta o Postgres tentar comprimir de novo
    ALTER TABLE memory_versions ALTER COLUMN package SET STORAGE EXTERNAL;
  `);

  // Formato antigo (um registro por arquivo em memory_files): converte em pacote e remove
  const { rows } = await pool.query("SELECT to_regclass('memory_files') IS NOT NULL AS exists");
  if (rows[0].exists) {
    const old = await pool.query("SELECT id FROM memory_versions WHERE package IS NULL");
    for (const { id } of old.rows) {
      const files = await pool.query("SELECT path, content, mtime FROM memory_files WHERE version_id = $1", [id]);
      const map = new Map(files.rows.map((r) => [r.path, { content: r.content, mtime: Number(r.mtime) }]));
      const pkg = buildPackage(map, { version: Number(id) });
      await pool.query("UPDATE memory_versions SET package = $1, package_bytes = $2 WHERE id = $3", [pkg, pkg.length, id]);
    }
    await pool.query("DROP TABLE memory_files");
    console.log(`[migração] ${old.rows.length} versão(ões) convertidas para pacote único`);
  }
  await pool.query("DELETE FROM memory_versions WHERE package IS NULL");
}

async function latestId(db) {
  const { rows } = await db.query("SELECT id FROM memory_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? Number(rows[0].id) : null;
}

// build(prevPackage | null, versionId) -> { pkg, fileCount, totalBytes }.
// Roda dentro da transação, com lock, para dois PCs enviando ao mesmo tempo
// não perderem mudanças um do outro.
async function saveVersion(pool, clientId, build) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE memory_versions IN EXCLUSIVE MODE");

    const prev = await client.query("SELECT package FROM memory_versions ORDER BY id DESC LIMIT 1");
    const { rows } = await client.query("SELECT nextval(pg_get_serial_sequence('memory_versions', 'id')) AS id");
    const versionId = Number(rows[0].id);
    const { pkg, fileCount, totalBytes } = build(prev.rows.length ? prev.rows[0].package : null, versionId);

    await client.query(
      `INSERT INTO memory_versions (id, client_id, file_count, total_bytes, package, package_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [versionId, clientId, fileCount, totalBytes, pkg, pkg.length]
    );
    await client.query(
      `DELETE FROM memory_versions
        WHERE id NOT IN (SELECT id FROM memory_versions ORDER BY id DESC LIMIT $1)`,
      [MAX_VERSIONS]
    );

    await client.query("COMMIT");
    return { versionId, fileCount, totalBytes, packageBytes: pkg.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Só os bytes prontos: nada de descompactar no server
async function loadLatestPackage(pool) {
  const { rows } = await pool.query("SELECT id, package FROM memory_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? { versionId: Number(rows[0].id), pkg: rows[0].package } : null;
}

async function listVersions(pool) {
  const { rows } = await pool.query(
    `SELECT id, client_id, created_at, file_count, total_bytes, package_bytes
       FROM memory_versions ORDER BY id DESC`
  );
  return rows.map((r) => ({
    id: Number(r.id),
    clientId: r.client_id,
    createdAt: r.created_at,
    fileCount: r.file_count,
    totalBytes: Number(r.total_bytes),
    packageBytes: Number(r.package_bytes),
  }));
}

module.exports = { createPool, migrate, saveVersion, latestId, loadLatestPackage, listVersions, MAX_VERSIONS };
