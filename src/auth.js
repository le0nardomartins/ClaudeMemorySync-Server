// Autenticação por assinatura Ed25519.
//
// Cada PC tem uma chave PRIVADA no próprio .env e a Railway guarda só as chaves
// PÚBLICAS (CLIENT_PUBLIC_KEYS). Nenhum segredo trafega na requisição: o cliente
// assina "MÉTODO\nCAMINHO\nTIMESTAMP\nSHA256(corpo)" e o server verifica.
// Vazar as variáveis da Railway não permite se passar por nenhum PC.

const crypto = require("crypto");

const MAX_SKEW_MS = 5 * 60 * 1000;

// "pc-casa:<base64>,pc-trabalho:<base64>" -> Map(clientId -> KeyObject)
function loadPublicKeys(raw) {
  const keys = new Map();
  for (const pair of (raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(":");
    if (idx < 1) throw new Error(`CLIENT_PUBLIC_KEYS inválida perto de "${pair.slice(0, 20)}"`);
    const id = pair.slice(0, idx);
    const raw32 = Buffer.from(pair.slice(idx + 1), "base64");
    if (raw32.length !== 32) throw new Error(`Chave pública de "${id}" não tem 32 bytes`);
    const key = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw32.toString("base64url") },
      format: "jwk",
    });
    keys.set(id, key);
  }
  if (keys.size === 0) throw new Error("CLIENT_PUBLIC_KEYS vazia: nenhum PC conseguiria se autenticar");
  return keys;
}

function signedMessage(method, path, timestamp, body) {
  const bodyHash = crypto.createHash("sha256").update(body || Buffer.alloc(0)).digest("hex");
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`);
}

// Teto de assinaturas lembradas. Só entram assinaturas VÁLIDAS (de PCs
// autorizados), então isso só enche se um PC seu fizer milhares de requisições
// em 5 minutos; nesse caso recusamos por segurança em vez de crescer.
const MAX_SEEN = 10000;

function createAuthMiddleware(publicKeys, { onFailure = () => {} } = {}) {
  // Assinaturas já usadas dentro da janela de 5 min: impede reenviar a mesma requisição
  const seen = new Map();

  function prune(now) {
    // Map mantém ordem de inserção: as mais antigas vêm primeiro
    for (const [sig, at] of seen) {
      if (now - at <= MAX_SKEW_MS) break;
      seen.delete(sig);
    }
  }

  return function auth(req, res, next) {
    const clientId = req.get("X-Client-Id");
    const timestamp = req.get("X-Timestamp");
    const signature = req.get("X-Signature");
    const deny = () => {
      onFailure(req);
      return res.status(401).json({ error: "não autorizado" });
    };

    if (!clientId || !timestamp || !signature) return deny();
    const key = publicKeys.get(clientId);
    if (!key) return deny();

    const now = Date.now();
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return deny();

    let sig;
    try {
      sig = Buffer.from(signature, "base64");
    } catch {
      return deny();
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const msg = signedMessage(req.method, req.originalUrl, timestamp, body);
    if (sig.length !== 64 || !crypto.verify(null, msg, key, sig)) return deny();

    prune(now);
    if (seen.has(signature)) return deny();
    if (seen.size >= MAX_SEEN) return res.status(503).json({ error: "ocupado, tente de novo" });
    seen.set(signature, now);

    req.clientId = clientId;
    next();
  };
}

module.exports = { loadPublicKeys, createAuthMiddleware, signedMessage, MAX_SKEW_MS };
