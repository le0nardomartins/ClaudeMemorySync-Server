// Defesas que rodam ANTES de qualquer trabalho caro (ler corpo, verificar
// assinatura, consultar o banco). Todas as estruturas em memória têm tamanho
// máximo e limpeza periódica: nada cresce sem limite.

const MAX_URL_LENGTH = 512;

// Conta falhas de autenticação por IP numa janela fixa e bloqueia quem passar do limite.
class FailureLimiter {
  constructor({ maxFailures = 10, windowMs = 15 * 60 * 1000, maxKeys = 10000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.entries = new Map(); // ip -> { count, resetAt }
    this.timer = setInterval(() => this.prune(Date.now()), 60 * 1000);
    this.timer.unref();
  }

  prune(now) {
    for (const [ip, e] of this.entries) if (e.resetAt <= now) this.entries.delete(ip);
  }

  isBlocked(ip) {
    const e = this.entries.get(ip);
    return Boolean(e && e.resetAt > Date.now() && e.count >= this.maxFailures);
  }

  fail(ip) {
    const now = Date.now();
    let e = this.entries.get(ip);
    if (!e || e.resetAt <= now) {
      if (this.entries.size >= this.maxKeys) {
        this.prune(now);
        // Ainda cheio (ataque distribuído): descarta o mais antigo
        if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value);
      }
      e = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(ip, e);
    }
    e.count++;
  }

  stop() {
    clearInterval(this.timer);
  }
}

// Limita operações pesadas simultâneas (zip/merge/banco). Não enfileira: recusa.
function concurrencyGate(max) {
  let active = 0;
  return function gate(req, res, next) {
    if (active >= max) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: "ocupado, tente de novo" });
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

// Cabeçalhos para uma API que só fala JSON/zip com clientes próprios
function securityHeaders(req, res, next) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  });
  next();
}

// Filtro barato antes de ler o corpo: cabeçalhos de auth presentes, cliente
// conhecido, horário dentro da janela, tamanho declarado aceitável.
function createPrecheck({ publicKeys, limiter, maxUploadBytes, maxSkewMs }) {
  return function precheck(req, res, next) {
    const ip = req.ip || "unknown";
    const deny = (status = 401, error = "não autorizado") => {
      if (status === 401) limiter.fail(ip);
      // Fecha a conexão: não deixa o cliente continuar mandando corpo
      res.set("Connection", "close");
      return res.status(status).json({ error });
    };

    if (limiter.isBlocked(ip)) return deny(429, "muitas tentativas");
    if (req.originalUrl.length > MAX_URL_LENGTH) return deny(414, "URL longa demais");

    const clientId = req.get("X-Client-Id");
    const ts = Number(req.get("X-Timestamp"));
    const sig = req.get("X-Signature") || "";
    if (!clientId || !publicKeys.has(clientId)) return deny();
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) return deny();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(sig)) return deny();

    const isUpload = req.method === "POST" && req.path === "/upload";
    const length = Number(req.get("Content-Length") || 0);
    if (isUpload) {
      // Exige tamanho declarado: sem upload "chunked" infinito
      if (!req.get("Content-Length") || !Number.isFinite(length) || length <= 0) return deny(411, "Content-Length obrigatório");
      if (length > maxUploadBytes) return deny(413, "zip grande demais");
    } else if (length > 0 || req.get("Transfer-Encoding")) {
      return deny(413, "esta rota não aceita corpo");
    }
    next();
  };
}

module.exports = { FailureLimiter, concurrencyGate, securityHeaders, createPrecheck };
