// Server de memória compartilhada do Claude (Railway).
//
// Rotas (todas exigem assinatura Ed25519, ver auth.js):
//   POST /upload            corpo = zip da NEW_MEMORY. Mescla com a última versão e salva.
//   GET  /latest[?since=N]  zip da versão mais nova (204 se não há nada mais novo que N).
//   GET  /versions          histórico (só metadados).
//
// Variáveis de ambiente:
//   DATABASE_URL        Postgres da Railway (referência ${{Postgres.DATABASE_URL}})
//   CLIENT_PUBLIC_KEYS  "pc-casa:<base64>,pc-trabalho:<base64>"  (gerar com npm run keygen)
//   MAX_UPLOAD_MB       opcional, padrão 50
//   DATABASE_SSL        opcional, "true" se conectar pelo proxy público
//   PORT                definida pela Railway

const express = require("express");
const { loadPublicKeys, createAuthMiddleware } = require("./auth");
const { readPackage, buildPackage, BadPackage } = require("./zip");
const { mergeSnapshots } = require("./merge");
const db = require("./db");

async function main() {
  const publicKeys = loadPublicKeys(process.env.CLIENT_PUBLIC_KEYS);
  const pool = db.createPool();
  await db.migrate(pool);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  const maxUpload = `${Number(process.env.MAX_UPLOAD_MB) || 50}mb`;
  // O corpo cru precisa existir ANTES da auth: a assinatura cobre o hash dele
  app.use(express.raw({ type: () => true, limit: maxUpload }));
  app.use(createAuthMiddleware(publicKeys));

  app.post("/upload", async (req, res, next) => {
    try {
      if (!req.is("application/zip")) return res.status(415).json({ error: "só aceito application/zip" });
      const incoming = readPackage(req.body);
      const saved = await db.saveVersion(pool, req.clientId, incoming, mergeSnapshots);
      console.log(`[upload] ${req.clientId} -> versão ${saved.versionId} (${saved.fileCount} arquivos)`);
      res.status(201).json(saved);
    } catch (err) {
      next(err);
    }
  });

  app.get("/latest", async (req, res, next) => {
    try {
      const latest = await db.loadLatest(pool);
      const since = Number(req.query.since);
      if (!latest || (Number.isFinite(since) && latest.versionId <= since)) return res.status(204).end();
      const zip = buildPackage(latest.files, { version: latest.versionId });
      res.set("Content-Type", "application/zip");
      res.set("X-Version-Id", String(latest.versionId));
      res.send(zip);
    } catch (err) {
      next(err);
    }
  });

  app.get("/versions", async (req, res, next) => {
    try {
      res.json(await db.listVersions(pool));
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => res.status(404).json({ error: "rota não encontrada" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BadPackage) return res.status(400).json({ error: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ error: `zip maior que ${maxUpload}` });
    console.error(err);
    res.status(500).json({ error: "erro interno" });
  });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`memory server na porta ${port}`));

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Falha ao iniciar:", err.message);
  process.exit(1);
});
