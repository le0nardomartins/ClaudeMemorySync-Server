// Server de memória compartilhada do Claude (Railway).
//
// Rotas (todas exigem assinatura Ed25519, ver auth.js):
//   POST /upload            corpo = zip da NEW_MEMORY. Mescla com a última versão e salva.
//   GET  /latest[?since=N]  zip da versão mais nova (204 se ela for a própria N).
//   GET  /versions          histórico (só metadados).
// Qualquer outra coisa, inclusive rota inexistente, recebe 401 sem assinatura:
// quem não está autorizado não descobre nem quais rotas existem.
//
// Ordem das defesas (da mais barata para a mais cara):
//   bloqueio por IP -> cabeçalhos de auth -> tamanho declarado -> leitura do corpo
//   -> assinatura Ed25519 -> limite de concorrência -> zip/merge/banco
//
// Variáveis de ambiente:
//   DATABASE_URL        Postgres da Railway (referência ${{Postgres.DATABASE_URL}})
//   CLIENT_PUBLIC_KEYS  "pc-casa:<base64>,pc-trabalho:<base64>"  (gerar com npm run keygen)
//   MAX_UPLOAD_MB       opcional, padrão 50
//   DATABASE_SSL        opcional, "true" se conectar pelo proxy público
//   PORT                definida pela Railway

const express = require("express");
const { loadPublicKeys, createAuthMiddleware, MAX_SKEW_MS } = require("./auth");
const { readPackage, BadPackage } = require("./zip");
const { nextPackage } = require("./versions");
const { FailureLimiter, concurrencyGate, securityHeaders, createPrecheck, accessLog, mb } = require("./security");
const db = require("./db");

const MAX_HEAVY_REQUESTS = 2;

async function main() {
  const publicKeys = loadPublicKeys(process.env.CLIENT_PUBLIC_KEYS);
  const pool = db.createPool();
  await db.migrate(pool);

  const maxUploadBytes = (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024;
  const limiter = new FailureLimiter();

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  // A Railway fica na frente com 1 proxy: req.ip passa a ser o IP real do cliente
  app.set("trust proxy", 1);

  // Falhas de auth: conta para o bloqueio e loga só a 1ª e o bloqueio (ataque não enche o log)
  const onFailure = (req, reason) => {
    const ip = req.ip || "unknown";
    const count = limiter.fail(ip);
    const who = req.get("X-Client-Id") ? ` (se apresentou como "${String(req.get("X-Client-Id")).slice(0, 64)}")` : "";
    if (count === 1) console.warn(`[recusado] ${ip}${who} ${req.method} ${req.path}: ${reason}`);
    if (count === limiter.maxFailures) console.warn(`[bloqueado] ${ip} após ${count} falhas, por 15 min`);
  };

  app.use(securityHeaders);
  app.use(createPrecheck({ publicKeys, limiter, maxUploadBytes, maxSkewMs: MAX_SKEW_MS, onFailure }));
  // Teto de requisições em andamento ANTES de ler corpo: a memória máxima usada
  // fica em ~MAX_HEAVY_REQUESTS x MAX_UPLOAD_MB, aconteça o que acontecer.
  app.use(concurrencyGate(MAX_HEAVY_REQUESTS));
  // A assinatura cobre o hash do corpo, por isso o corpo é lido antes da verificação
  app.use(express.raw({ type: () => true, limit: maxUploadBytes }));
  app.use(createAuthMiddleware(publicKeys, { onFailure: (req) => onFailure(req, "assinatura inválida ou reenviada") }));
  app.use(accessLog);

  app.post("/upload", async (req, res, next) => {
    try {
      if (!req.is("application/zip")) return res.status(415).json({ error: "só aceito application/zip" });
      const incoming = readPackage(req.body);
      req.body = null; // libera o zip cru antes do merge
      const saved = await db.saveVersion(pool, req.clientId, (prev, id) => nextPackage(prev, incoming, id));
      res.locals.detail =
        `versão ${saved.versionId} salva: ${saved.fileCount} arquivos, ` +
        `${mb(saved.totalBytes)} -> ${mb(saved.packageBytes)} compactado`;
      res.status(201).json(saved);
    } catch (err) {
      next(err);
    }
  });

  // Repassa o pacote pronto do banco: zero descompactação/compactação no server
  app.get("/latest", async (req, res, next) => {
    try {
      const since = Number(req.query.since);
      const latestId = await db.latestId(pool);
      // Igualdade, não "<=": se o banco for recriado os ids recomeçam e o PC ainda precisa baixar
      if (latestId === null || latestId === since) {
        res.locals.detail = "PC já está na versão mais nova";
        return res.status(204).end();
      }
      const latest = await db.loadLatestPackage(pool);
      res.locals.detail = `enviou versão ${latest.versionId}`;
      res.set("Content-Type", "application/zip");
      res.set("X-Version-Id", String(latest.versionId));
      res.send(latest.pkg);
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
    if (res.headersSent) return res.end();
    if (err instanceof BadPackage) return res.status(400).json({ error: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "zip grande demais" });
    if (err.type === "request.aborted") return res.end();
    console.error("[erro]", err.message);
    res.status(500).json({ error: "erro interno" });
  });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () =>
    console.log(`memory server na porta ${port} | PCs autorizados: ${[...publicKeys.keys()].join(", ")}`)
  );

  // Conexões lentas ou penduradas (slowloris) não seguram memória/sockets
  server.headersTimeout = 15 * 1000;
  server.requestTimeout = 5 * 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    limiter.stop();
    server.close(() => pool.end().finally(() => process.exit(0)));
    // Se alguma conexão não fechar, encerra mesmo assim
    setTimeout(() => process.exit(0), 10 * 1000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.message);
});

main().catch((err) => {
  console.error("Falha ao iniciar:", err.message);
  process.exit(1);
});
