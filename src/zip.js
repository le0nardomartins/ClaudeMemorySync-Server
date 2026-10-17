// Formato ANTIGO (um zip inteiro por versão). Só a migração do db.js ainda lê
// isso, para converter as versões guardadas em manifesto + blobs.
//
// O zip sempre traz um manifest.json na raiz:
//   { "files": { "<caminho/posix>": { "sha256": "...", "size": 123, "mtime": 1700000000.5 } } }
// O server só aceita o pacote se todo arquivo do manifesto estiver presente com o
// hash certo, e nenhum arquivo fora dele.

const AdmZip = require("adm-zip");
const { MANIFEST, MAX_FILES, MAX_UNCOMPRESSED, BadPackage, sha256, isSafePath } = require("./bundle");

// Buffer zip -> Map(path -> { content, mtime })
function readPackage(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new BadPackage("arquivo não é um zip válido");
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > MAX_FILES + 1) throw new BadPackage("zip com arquivos demais");

  // Confere o tamanho descompactado ANTES de extrair (zip bomb)
  const total = entries.reduce((sum, e) => sum + e.header.size, 0);
  if (total > MAX_UNCOMPRESSED) throw new BadPackage("zip grande demais depois de descompactado");

  const byName = new Map(entries.map((e) => [e.entryName, e]));
  if (byName.size !== entries.length) throw new BadPackage("zip com nomes repetidos");
  const manifestEntry = byName.get(MANIFEST);
  if (!manifestEntry) throw new BadPackage("zip sem manifest.json");
  if (manifestEntry.header.size > 5 * 1024 * 1024) throw new BadPackage("manifest.json grande demais");

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString("utf-8"));
  } catch {
    throw new BadPackage("manifest.json inválido");
  }
  const listed = manifest && typeof manifest.files === "object" ? manifest.files : null;
  if (!listed) throw new BadPackage("manifest.json sem a lista de arquivos");

  const files = new Map();
  let extracted = 0;
  for (const [path, meta] of Object.entries(listed)) {
    if (!isSafePath(path) || path === MANIFEST) throw new BadPackage(`caminho inválido: ${path}`);
    const entry = byName.get(path);
    if (!entry) throw new BadPackage(`faltou no zip: ${path}`);
    const content = entry.getData();
    // O tamanho do cabeçalho pode mentir: confere o real
    extracted += content.length;
    if (content.length !== entry.header.size || extracted > MAX_UNCOMPRESSED) {
      throw new BadPackage(`tamanho inválido: ${path}`);
    }
    if (sha256(content) !== meta.sha256) throw new BadPackage(`hash não confere: ${path}`);
    files.set(path, { content, mtime: Number(meta.mtime) || 0 });
  }
  for (const name of byName.keys()) {
    if (name !== MANIFEST && !files.has(name)) throw new BadPackage(`arquivo fora do manifesto: ${name}`);
  }
  return files;
}

// Map(path -> { content, mtime }) -> Buffer zip com manifest.json
function buildPackage(files, extra = {}) {
  const zip = new AdmZip();
  const manifest = { ...extra, files: {} };
  for (const [path, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    zip.addFile(path, f.content);
    manifest.files[path] = { sha256: sha256(f.content), size: f.content.length, mtime: f.mtime };
  }
  zip.addFile(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));
  return zip.toBuffer();
}

module.exports = { readPackage, buildPackage, BadPackage, isSafePath, sha256 };
