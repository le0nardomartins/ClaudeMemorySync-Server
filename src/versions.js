// Monta o pacote de uma versão nova. Roda UMA vez por upload: o zip resultante
// fica salvo pronto no banco e os downloads só repassam esses bytes, sem
// descompactar, mesclar nem compactar de novo.

const { readPackage, buildPackage } = require("./zip");
const { mergeSnapshots } = require("./merge");

// prevPackage: Buffer zip da última versão (ou null). incoming: Map do upload.
function nextPackage(prevPackage, incoming, versionId) {
  const files = prevPackage ? mergeSnapshots(readPackage(prevPackage), incoming) : incoming;
  let totalBytes = 0;
  for (const f of files.values()) totalBytes += f.content.length;
  return {
    pkg: buildPackage(files, { version: versionId }),
    fileCount: files.size,
    totalBytes,
  };
}

module.exports = { nextPackage };
