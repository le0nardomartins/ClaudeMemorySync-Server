// Formato binário trocado com os PCs ("bundle"): uma sequência de registros
//   [4 bytes BE: tamanho do nome][nome utf-8][4 bytes BE: tamanho dos dados][dados deflate-raw]
// O nome é "manifest.json" ou o sha256 (hex) do conteúdo DEScompactado.
// Cada arquivo viaja e fica guardado compactado uma vez só: o server repassa
// esses bytes sem descompactar nem compactar de novo.

const crypto = require("crypto");
const zlib = require("zlib");

const MANIFEST = "manifest.json";
const MAX_FILES = 5000;
const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_MANIFEST = 5 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;

// Nunca viajam: dependências reinstaláveis, lixo de ferramenta e as skills que
// o app Claude Desktop gerencia sozinho em cada PC. Mesma regra em remote_client.py.
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "__pycache__"]);
const EXCLUDED_PREFIXES = ["skills/synced/"];

class BadPackage extends Error {}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Barra zip slip: caminho absoluto, "..", drive do Windows ou barra invertida
function isSafePath(p) {
  if (!p || p.length > 512) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function isExcluded(p) {
  return p.split("/").some((seg) => EXCLUDED_DIRS.has(seg)) || EXCLUDED_PREFIXES.some((pre) => p.startsWith(pre));
}

const deflate = (buf) => zlib.deflateRawSync(buf, { level: 9 });

// Descompacta com teto: zip bomb estoura aqui em vez de encher a memória
function inflate(buf, maxBytes) {
  try {
    return zlib.inflateRawSync(buf, { maxOutputLength: Math.max(1, maxBytes) });
  } catch {
    throw new BadPackage("dados compactados inválidos ou grandes demais");
  }
}

// [{ name, data }] -> Buffer
function encode(records) {
  const parts = [];
  for (const { name, data } of records) {
    const n = Buffer.from(name, "utf-8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(n.length);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    parts.push(head, n, len, data);
  }
  return Buffer.concat(parts);
}

// Buffer -> [{ name, data }]
function decode(buf, maxRecords = MAX_FILES + 1) {
  const records = [];
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new BadPackage("bundle truncado");
  };
  while (pos < buf.length) {
    if (records.length >= maxRecords) throw new BadPackage("bundle com registros demais");
    need(4);
    const nameLen = buf.readUInt32BE(pos);
    pos += 4;
    if (nameLen === 0 || nameLen > 512) throw new BadPackage("nome de registro inválido");
    need(nameLen);
    const name = buf.toString("utf-8", pos, pos + nameLen);
    pos += nameLen;
    need(4);
    const dataLen = buf.readUInt32BE(pos);
    pos += 4;
    need(dataLen);
    records.push({ name, data: buf.subarray(pos, pos + dataLen) });
    pos += dataLen;
  }
  return records;
}

// Valida { files: { path: { sha256, size, mtime } } } -> Map(path -> meta)
function parseManifest(obj) {
  const listed = obj && typeof obj.files === "object" && !Array.isArray(obj.files) ? obj.files : null;
  if (!listed) throw new BadPackage("manifest.json sem a lista de arquivos");
  const entries = Object.entries(listed);
  if (entries.length > MAX_FILES) throw new BadPackage("arquivos demais");
  const files = new Map();
  let total = 0;
  for (const [path, meta] of entries) {
    if (!isSafePath(path) || path === MANIFEST) throw new BadPackage(`caminho inválido: ${path}`);
    if (!meta || !SHA_RE.test(meta.sha256)) throw new BadPackage(`hash inválido: ${path}`);
    const size = Number(meta.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new BadPackage(`tamanho inválido: ${path}`);
    total += size;
    files.set(path, { sha256: meta.sha256, size, mtime: Number(meta.mtime) || 0 });
  }
  if (total > MAX_UNCOMPRESSED) throw new BadPackage("arquivos grandes demais depois de descompactados");
  return files;
}

// Map(path -> meta) -> objeto JSON do manifesto
function manifestObject(files, version) {
  const out = { version, files: {} };
  for (const [path, m] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    out.files[path] = { sha256: m.sha256, size: m.size, mtime: m.mtime };
  }
  return out;
}

// Corpo do POST /upload: manifest.json + o conteúdo que o server ainda não tem.
// Devolve { files: Map(path -> meta), blobs: Map(sha -> dados compactados) }.
// Cada blob é descompactado só para conferir o hash, e depois descartado.
function readUpload(buffer) {
  const records = decode(buffer);
  if (!records.length || records[0].name !== MANIFEST) throw new BadPackage("bundle sem manifest.json no início");

  let manifest;
  try {
    manifest = JSON.parse(inflate(records[0].data, MAX_MANIFEST).toString("utf-8"));
  } catch (err) {
    if (err instanceof BadPackage) throw err;
    throw new BadPackage("manifest.json inválido");
  }
  const all = parseManifest(manifest);
  const sizeOf = new Map([...all.values()].map((m) => [m.sha256, m.size]));

  const blobs = new Map();
  let extracted = 0;
  for (const { name, data } of records.slice(1)) {
    if (!SHA_RE.test(name)) throw new BadPackage(`registro inválido: ${name.slice(0, 80)}`);
    if (blobs.has(name)) throw new BadPackage("registro repetido");
    if (!sizeOf.has(name)) throw new BadPackage(`conteúdo fora do manifesto: ${name}`);
    const content = inflate(data, MAX_UNCOMPRESSED - extracted);
    extracted += content.length;
    if (content.length !== sizeOf.get(name) || sha256(content) !== name) throw new BadPackage(`hash não confere: ${name}`);
    blobs.set(name, data);
  }

  const files = new Map([...all].filter(([path]) => !isExcluded(path)));
  return { files, blobs };
}

module.exports = {
  MANIFEST,
  MAX_FILES,
  MAX_UNCOMPRESSED,
  BadPackage,
  sha256,
  isSafePath,
  isExcluded,
  deflate,
  inflate,
  encode,
  decode,
  parseManifest,
  manifestObject,
  readUpload,
};
