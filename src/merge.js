// Mescla "complementar": junta duas versões de um arquivo sem apagar nada.
//
// - Texto: linhas que só existem em um lado entram; linhas que só existem no
//   outro ficam. Quando o MESMO trecho foi alterado nos dois lados, ganha o
//   arquivo mais novo (mtime).
// - JSON: chaves novas entram, listas são somadas sem duplicar e, em valor
//   divergente, ganha o mais novo.
// - Binário: ganha o mais novo inteiro.
//
// A mesma lógica existe em Python (src/components/merge_sharing.py) para o
// merge no PC. Mudou uma, mude a outra.

const { diffArrays } = require("diff");

const decoder = new TextDecoder("utf-8", { fatal: true });

function asText(buf) {
  try {
    return decoder.decode(buf);
  } catch {
    return null;
  }
}

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

const bare = (line) => line.replace(/\r?\n$/, "");

function mergeText(oldText, newText, newIsNewer) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const parts = diffArrays(a, b, { comparator: (x, y) => bare(x) === bare(y) });

  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    if (!p.added && !p.removed) {
      out.push(...p.value);
    } else if (p.removed && next && next.added) {
      // Mesmo trecho alterado dos dois lados
      out.push(...(newIsNewer ? next.value : p.value));
      i++;
    } else {
      // Só um lado tem essas linhas: complementa
      out.push(...p.value);
    }
  }
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].endsWith("\n")) out[i] += "\n";
  }
  return out.join("");
}

function mergeJsonValue(oldV, newV, newIsNewer) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(oldV) && isObj(newV)) {
    const res = { ...oldV };
    for (const [k, v] of Object.entries(newV)) {
      res[k] = k in oldV ? mergeJsonValue(oldV[k], v, newIsNewer) : v;
    }
    return res;
  }
  if (Array.isArray(oldV) && Array.isArray(newV)) {
    const known = new Set(oldV.map((x) => JSON.stringify(x)));
    return [...oldV, ...newV.filter((x) => !known.has(JSON.stringify(x)))];
  }
  if (JSON.stringify(oldV) === JSON.stringify(newV)) return oldV;
  return newIsNewer ? newV : oldV;
}

// old/neu: { content: Buffer, mtime: number }. Devolve Buffer mesclado.
function mergeFile(path, old, neu) {
  if (old.content.equals(neu.content)) return old.content;
  const newIsNewer = neu.mtime >= old.mtime;
  const oldText = asText(old.content);
  const newText = asText(neu.content);
  if (oldText === null || newText === null) return newIsNewer ? neu.content : old.content;

  if (path.toLowerCase().endsWith(".json")) {
    try {
      const merged = mergeJsonValue(JSON.parse(oldText), JSON.parse(newText), newIsNewer);
      return Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf-8");
    } catch {
      // JSON inválido em algum lado: trata como texto
    }
  }
  return Buffer.from(mergeText(oldText, newText, newIsNewer), "utf-8");
}

// Junta dois conjuntos de arquivos (Map path -> {content, mtime}).
// Nada some: arquivo que só existe em um lado é mantido.
function mergeSnapshots(previous, incoming) {
  const result = new Map(previous);
  for (const [path, neu] of incoming) {
    const old = previous.get(path);
    if (!old) {
      result.set(path, neu);
      continue;
    }
    result.set(path, {
      content: mergeFile(path, old, neu),
      mtime: Math.max(old.mtime, neu.mtime),
    });
  }
  return result;
}

module.exports = { mergeText, mergeJsonValue, mergeFile, mergeSnapshots };
