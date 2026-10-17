// Formato binário trocado com os PCs ("bundle"): uma sequência de registros
//   [4 bytes BE: tamanho do nome][nome utf-8][4 bytes BE: tamanho dos dados][dados]
//
// O server não entende o conteúdo: manifesto e blobs chegam SELADOS pelo PC
// (cifrados com AES-256-GCM quando o PC usa SYNC_KEY). Ele só guarda e devolve
// os bytes, e usa a lista de ids (`refs`) para saber o que cada versão usa.
//
// Corpo do POST /upload:
//   "meta.json"  JSON { base: <versão em que o PC se baseou | null>, version: base + 1, refs: [id...] }
//   "manifest"   manifesto selado
//   "<id>"       blobs novos (id = 64 hex: HMAC-SHA256 ou sha256 do conteúdo, calculado no PC)

const MAX_REFS = 20000;
const MAX_MANIFEST = 20 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{64}$/;

class BadPackage extends Error {}

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
function decode(buf, maxRecords = MAX_REFS + 2) {
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

// Corpo do POST /upload -> { base, version, refs: Set, manifest: Buffer, blobs: Map(id -> Buffer) }
function readUpload(buffer) {
  const records = decode(buffer);
  if (records.length < 2 || records[0].name !== "meta.json" || records[1].name !== "manifest") {
    throw new BadPackage("formato antigo ou inválido: atualize o cliente (git pull)");
  }
  let meta;
  try {
    meta = JSON.parse(records[0].data.toString("utf-8"));
  } catch {
    throw new BadPackage("meta.json inválido");
  }
  const base = meta.base === null ? null : Number(meta.base);
  if (base !== null && !Number.isSafeInteger(base)) throw new BadPackage("base inválida");
  if (meta.version !== (base ?? 0) + 1) throw new BadPackage("version precisa ser base + 1");
  if (!Array.isArray(meta.refs) || meta.refs.length > MAX_REFS || !meta.refs.every((r) => ID_RE.test(r))) {
    throw new BadPackage("refs inválidas");
  }
  const refs = new Set(meta.refs);
  const manifest = records[1].data;
  if (!manifest.length || manifest.length > MAX_MANIFEST) throw new BadPackage("manifesto vazio ou grande demais");

  const blobs = new Map();
  for (const { name, data } of records.slice(2)) {
    if (!ID_RE.test(name)) throw new BadPackage(`registro inválido: ${name.slice(0, 80)}`);
    if (blobs.has(name)) throw new BadPackage("registro repetido");
    if (!refs.has(name)) throw new BadPackage(`blob fora das refs: ${name}`);
    blobs.set(name, data);
  }
  return { base, version: meta.version, refs, manifest, blobs };
}

module.exports = { BadPackage, ID_RE, MAX_REFS, encode, decode, readUpload };
