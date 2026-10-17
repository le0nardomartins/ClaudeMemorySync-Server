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
    return ++e.count;
  }

  stop() {
    clearInterval(this.timer);
  }
}

// Limita operações pesadas simultâneas (merge/banco). Não enfileira: recusa.
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

// Cabeçalhos para uma API que só fala JSON/bundle com clientes próprios
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
// onFailure(req, motivo) é chamado em toda recusa 401 (conta para o bloqueio por IP).
function createPrecheck({ publicKeys, limiter, maxUploadBytes, maxSkewMs, onFailure }) {
  return function precheck(req, res, next) {
    const ip = req.ip || "unknown";
    const deny = (status = 401, error = "não autorizado") => {
      if (status === 401) onFailure(req, "cabeçalhos de autenticação inválidos");
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

    const hasBody = req.method === "POST" && (req.path === "/upload" || req.path === "/blobs");
    const length = Number(req.get("Content-Length") || 0);
    if (hasBody) {
      // Exige tamanho declarado: sem upload "chunked" infinito
      if (!req.get("Content-Length") || !Number.isFinite(length) || length <= 0) return deny(411, "Content-Length obrigatório");
      if (length > maxUploadBytes) return deny(413, "corpo grande demais");
    } else if (length > 0 || req.get("Transfer-Encoding")) {
      return deny(413, "esta rota não aceita corpo");
    }
    next();
  };
}

const mb = (bytes) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

// Uma linha por requisição autorizada: PC, IP, rota, status, MB recebidos/enviados, tempo.
// Detalhes extras da rota (ex.: versão criada) vêm de res.locals.detail.
function accessLog(req, res, next) {
  const start = process.hrtime.bigint();
  const received = Buffer.isBuffer(req.body) ? req.body.length : 0;
  res.on("finish", () => {
    const sent = Number(res.get("Content-Length")) || 0;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const detail = res.locals.detail ? ` | ${res.locals.detail}` : "";
    console.log(
      `[${req.clientId}] ${req.ip} ${req.method} ${req.path} -> ${res.statusCode}` +
        ` | recebido ${mb(received)} | enviado ${mb(sent)} | ${ms.toFixed(0)} ms${detail}`
    );
  });
  next();
}

module.exports = { FailureLimiter, concurrencyGate, securityHeaders, createPrecheck, accessLog, mb };
