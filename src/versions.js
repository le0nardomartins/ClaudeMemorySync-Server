// Monta a versão nova a partir da anterior e do que o PC enviou.
// Trabalha só com manifestos (path -> sha256/size/mtime): o conteúdo só é lido
// para os arquivos que mudaram dos dois lados e precisam de merge de verdade.

const { mergeFile } = require("./merge");
const { sha256, isExcluded } = require("./bundle");

// prev, incoming: Map(path -> { sha256, size, mtime }). load(sha) -> Promise<Buffer>.
// Devolve { files, created: Map(sha -> conteúdo gerado pelo merge) }.
async function mergeManifests(prev, incoming, load) {
  const files = new Map([...prev].filter(([path]) => !isExcluded(path)));
  const created = new Map();
  for (const [path, neu] of incoming) {
    const old = files.get(path);
    if (!old) {
      files.set(path, neu);
      continue;
    }
    const mtime = Math.max(old.mtime, neu.mtime);
    if (old.sha256 === neu.sha256) {
      files.set(path, { ...old, mtime });
      continue;
    }
    const content = mergeFile(
      path,
      { content: await load(old.sha256), mtime: old.mtime },
      { content: await load(neu.sha256), mtime: neu.mtime }
    );
    const sha = sha256(content);
    if (sha !== old.sha256 && sha !== neu.sha256) created.set(sha, content);
    files.set(path, { sha256: sha, size: content.length, mtime });
  }
  return { files, created };
}

// Mesmos caminhos com o mesmo conteúdo (mtime não conta)
function sameContent(a, b) {
  if (a.size !== b.size) return false;
  for (const [path, m] of a) if (b.get(path)?.sha256 !== m.sha256) return false;
  return true;
}

module.exports = { mergeManifests, sameContent };
