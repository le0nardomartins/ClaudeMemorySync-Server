// Histórico de versões no Postgres da Railway.
// Cada envio vira uma linha em memory_versions e seus arquivos ficam em
// memory_files como bytea. Só as MAX_VERSIONS mais novas são mantidas.

const { Pool } = require("pg");
const { sha256 } = require("./zip");

const MAX_VERSIONS = 5;

function createPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não definida");
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // Pela rede interna da Railway (postgres.railway.internal) não precisa de SSL.
    // Pelo proxy público, defina DATABASE_SSL=true.
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 5,
  });
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id          BIGSERIAL PRIMARY KEY,
      client_id   TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      file_count  INTEGER     NOT NULL,
      total_bytes BIGINT      NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_files (
      version_id BIGINT           NOT NULL REFERENCES memory_versions(id) ON DELETE CASCADE,
      path       TEXT             NOT NULL,
      content    BYTEA            NOT NULL,
      sha256     TEXT             NOT NULL,
      mtime      DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (version_id, path)
    );
  `);
}

async function latestVersionId(client) {
  const { rows } = await client.query("SELECT id FROM memory_versions ORDER BY id DESC LIMIT 1");
  return rows.length ? Number(rows[0].id) : null;
}

async function loadFiles(client, versionId) {
  const { rows } = await client.query(
    "SELECT path, content, mtime FROM memory_files WHERE version_id = $1",
    [versionId]
  );
  return new Map(rows.map((r) => [r.path, { content: r.content, mtime: Number(r.mtime) }]));
}

// mergeFn(previousFiles, incomingFiles) -> files. Roda dentro da transação, com
// lock, para dois PCs enviando ao mesmo tempo não perderem mudanças um do outro.
async function saveVersion(pool, clientId, incoming, mergeFn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE memory_versions IN EXCLUSIVE MODE");

    const prevId = await latestVersionId(client);
    const files = prevId ? mergeFn(await loadFiles(client, prevId), incoming) : incoming;
    const totalBytes = [...files.values()].reduce((s, f) => s + f.content.length, 0);

    const { rows } = await client.query(
      "INSERT INTO memory_versions (client_id, file_count, total_bytes) VALUES ($1, $2, $3) RETURNING id",
      [clientId, files.size, totalBytes]
    );
    const versionId = Number(rows[0].id);

    for (const [path, f] of files) {
      await client.query(
        "INSERT INTO memory_files (version_id, path, content, sha256, mtime) VALUES ($1, $2, $3, $4, $5)",
        [versionId, path, f.content, sha256(f.content), f.mtime]
      );
    }

    // Mantém só as 5 mais novas; os arquivos caem junto pelo ON DELETE CASCADE
    await client.query(
      `DELETE FROM memory_versions
        WHERE id NOT IN (SELECT id FROM memory_versions ORDER BY id DESC LIMIT $1)`,
      [MAX_VERSIONS]
    );

    await client.query("COMMIT");
    return { versionId, fileCount: files.size, totalBytes };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function loadLatest(pool) {
  const client = await pool.connect();
  try {
    const id = await latestVersionId(client);
    return id ? { versionId: id, files: await loadFiles(client, id) } : null;
  } finally {
    client.release();
  }
}

async function listVersions(pool) {
  const { rows } = await pool.query(
    "SELECT id, client_id, created_at, file_count, total_bytes FROM memory_versions ORDER BY id DESC"
  );
  return rows.map((r) => ({
    id: Number(r.id),
    clientId: r.client_id,
    createdAt: r.created_at,
    fileCount: r.file_count,
    totalBytes: Number(r.total_bytes),
  }));
}

module.exports = { createPool, migrate, saveVersion, loadLatest, listVersions, MAX_VERSIONS };
