const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const { mergeText, mergeJsonValue, mergeSnapshots } = require("../src/merge");
const { readPackage, buildPackage, BadPackage, isSafePath } = require("../src/zip");
const { loadPublicKeys, createAuthMiddleware, signedMessage } = require("../src/auth");

const file = (text, mtime) => ({ content: Buffer.from(text), mtime });

test("texto: linhas novas dos dois lados entram", () => {
  const out = mergeText("a\nb\nc\n", "a\nb\nNOVA\nc\n", true);
  assert.strictEqual(out, "a\nb\nNOVA\nc\n");
  // Linha que só existe no antigo não é apagada
  assert.strictEqual(mergeText("a\nLOCAL\nc\n", "a\nc\n", true), "a\nLOCAL\nc\n");
});

test("texto: mesma linha alterada nos dois lados -> ganha o mais novo", () => {
  assert.strictEqual(mergeText("a\nvelho\nc\n", "a\nnovo\nc\n", true), "a\nnovo\nc\n");
  assert.strictEqual(mergeText("a\nvelho\nc\n", "a\nnovo\nc\n", false), "a\nvelho\nc\n");
});

test("texto: arquivo sem \\n final não gruda linhas", () => {
  assert.strictEqual(mergeText("a\nb", "a\nb\nc", true), "a\nb\nc");
});

test("json: chaves somam, listas sem duplicar, conflito -> mais novo", () => {
  const out = mergeJsonValue(
    { env: { A: "1", B: "x" }, allow: ["r1", "r2"] },
    { env: { B: "y", C: "3" }, allow: ["r2", "r3"] },
    true
  );
  assert.deepStrictEqual(out, { env: { A: "1", B: "y", C: "3" }, allow: ["r1", "r2", "r3"] });
});

test("snapshots: nada some e arquivos novos entram", () => {
  const prev = new Map([["a.md", file("x\n", 1)], ["so-antigo.md", file("y\n", 1)]]);
  const inc = new Map([["a.md", file("x\nz\n", 2)], ["novo.md", file("n\n", 2)]]);
  const out = mergeSnapshots(prev, inc);
  assert.deepStrictEqual([...out.keys()].sort(), ["a.md", "novo.md", "so-antigo.md"]);
  assert.strictEqual(out.get("a.md").content.toString(), "x\nz\n");
  assert.strictEqual(out.get("a.md").mtime, 2);
});

test("zip: ida e volta preserva arquivos e mtime", () => {
  const files = new Map([["skills/a/SKILL.md", file("oi\n", 123.5)], ["bin.dat", { content: Buffer.from([0, 255]), mtime: 9 }]]);
  const back = readPackage(buildPackage(files));
  assert.strictEqual(back.get("skills/a/SKILL.md").content.toString(), "oi\n");
  assert.strictEqual(back.get("skills/a/SKILL.md").mtime, 123.5);
  assert.deepStrictEqual([...back.get("bin.dat").content], [0, 255]);
});

test("zip: recusa zip slip, hash errado e arquivo fora do manifesto", () => {
  for (const p of ["../x", "/etc/x", "C:/x", "a\\b", "a//b", "./a"]) assert.strictEqual(isSafePath(p), false, p);

  const bad = (mutate) => {
    const zip = new AdmZip();
    const manifest = { files: { "a.md": { sha256: crypto.createHash("sha256").update("a").digest("hex"), mtime: 1 } } };
    zip.addFile("a.md", Buffer.from("a"));
    mutate(zip, manifest);
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    return () => readPackage(zip.toBuffer());
  };
  assert.throws(bad((z, m) => { m.files["a.md"].sha256 = "0"; }), BadPackage);
  assert.throws(bad((z) => z.addFile("extra.md", Buffer.from("x"))), BadPackage);
  assert.throws(bad((z, m) => { m.files["../fora.md"] = m.files["a.md"]; }), BadPackage);
  assert.throws(() => readPackage(Buffer.from("não sou zip")), BadPackage);
});

const bundle = require("../src/bundle");
const { mergeManifests, sameContent } = require("../src/versions");

const meta = (text, mtime) => ({ sha256: bundle.sha256(Buffer.from(text)), size: Buffer.byteLength(text), mtime });

// Monta o corpo de um POST /upload como o remote_client.py faz
function uploadBody(files, include = Object.keys(files)) {
  const manifest = { files: {} };
  for (const [p, [text, mtime]] of Object.entries(files)) manifest.files[p] = meta(text, mtime);
  const records = [{ name: "manifest.json", data: bundle.deflate(Buffer.from(JSON.stringify(manifest))) }];
  for (const p of include) records.push({ name: manifest.files[p].sha256, data: bundle.deflate(Buffer.from(files[p][0])) });
  return bundle.encode(records);
}

test("bundle: ida e volta, e recusa dados truncados", () => {
  const recs = [{ name: "a", data: Buffer.from([1, 2, 3]) }, { name: "b".repeat(64), data: Buffer.alloc(0) }];
  const back = bundle.decode(bundle.encode(recs));
  assert.deepStrictEqual(back.map((r) => [r.name, [...r.data]]), [["a", [1, 2, 3]], ["b".repeat(64), []]]);
  assert.throws(() => bundle.decode(bundle.encode(recs).subarray(0, 10)), bundle.BadPackage);
  assert.throws(() => bundle.inflate(bundle.deflate(Buffer.alloc(1000)), 10), bundle.BadPackage, "zip bomb");
});

test("upload: aceita conteúdo parcial, descarta pastas excluídas e confere hash", () => {
  const files = { "a.md": ["x\n", 1], "b.md": ["y\n", 1], "skills/s/node_modules/m.js": ["m", 1], "skills/synced/k/SKILL.md": ["k", 1] };
  const up = bundle.readUpload(uploadBody(files, ["a.md"]));
  assert.deepStrictEqual([...up.files.keys()].sort(), ["a.md", "b.md"]);
  assert.deepStrictEqual([...up.blobs.keys()], [meta("x\n").sha256]);

  // Conteúdo com hash diferente do nome do registro
  const forged = bundle.encode([
    { name: "manifest.json", data: bundle.deflate(Buffer.from(JSON.stringify({ files: { "a.md": meta("x", 1) } }))) },
    { name: meta("x").sha256, data: bundle.deflate(Buffer.from("y")) },
  ]);
  assert.throws(() => bundle.readUpload(forged), bundle.BadPackage);
  // Conteúdo que não está no manifesto
  const extra = bundle.encode([
    { name: "manifest.json", data: bundle.deflate(Buffer.from(JSON.stringify({ files: {} }))) },
    { name: meta("z").sha256, data: bundle.deflate(Buffer.from("z")) },
  ]);
  assert.throws(() => bundle.readUpload(extra), bundle.BadPackage);
  assert.throws(() => bundle.readUpload(uploadBody({ "../x": ["x", 1] })), bundle.BadPackage);
});

test("versões: merge só lê o conteúdo de quem mudou dos dois lados", async () => {
  const store = new Map();
  const put = (t) => (store.set(bundle.sha256(Buffer.from(t)), Buffer.from(t)), meta(t));
  put("igual\n");
  put("a\nb\n");
  put("a\nNOVA\nb\n");
  const loaded = [];
  const load = async (sha) => (loaded.push(sha), store.get(sha));

  const prev = new Map([
    ["igual.md", { ...meta("igual\n"), mtime: 1 }],
    ["texto.md", { ...meta("a\nb\n"), mtime: 1 }],
    ["so-antigo.md", { ...meta("o\n"), mtime: 1 }],
    ["skills/synced/x.md", { ...meta("s"), mtime: 1 }],
  ]);
  const incoming = new Map([
    ["igual.md", { ...meta("igual\n"), mtime: 5 }],
    ["texto.md", { ...meta("a\nNOVA\nb\n"), mtime: 2 }],
    ["novo.md", { ...meta("n\n"), mtime: 2 }],
  ]);
  const { files, created } = await mergeManifests(prev, incoming, load);
  assert.deepStrictEqual([...files.keys()].sort(), ["igual.md", "novo.md", "so-antigo.md", "texto.md"]);
  assert.strictEqual(files.get("igual.md").mtime, 5);
  assert.strictEqual(files.get("texto.md").sha256, meta("a\nNOVA\nb\n").sha256);
  assert.strictEqual(loaded.length, 2, "só texto.md precisou de conteúdo");
  assert.strictEqual(created.size, 0, "merge deu igual ao recebido: nada novo a guardar");
  assert.ok(sameContent(files, new Map(files)));
  assert.ok(!sameContent(files, prev));
});

test("auth: aceita assinatura válida uma vez, recusa replay, chave errada e horário velho", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const auth = createAuthMiddleware(loadPublicKeys(`pc:${pub}`));

  const call = (headers, body = Buffer.from("zip")) => {
    let status = 200;
    const req = { method: "POST", originalUrl: "/upload", body, get: (h) => headers[h] };
    const res = { status: (s) => { status = s; return { json: () => {} }; } };
    let passed = false;
    auth(req, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  const sign = (ts, key = privateKey, body = Buffer.from("zip")) =>
    crypto.sign(null, signedMessage("POST", "/upload", ts, body), key).toString("base64");

  const ts = String(Date.now());
  const headers = { "X-Client-Id": "pc", "X-Timestamp": ts, "X-Signature": sign(ts) };
  assert.strictEqual(call(headers), 200);
  assert.strictEqual(call(headers), 401, "replay");
  assert.strictEqual(call({ ...headers, "X-Signature": sign(String(Date.now() + 1)) }), 401, "ts diferente do assinado");
  assert.strictEqual(call(headers, Buffer.from("outro corpo")), 401, "corpo alterado");

  const other = crypto.generateKeyPairSync("ed25519").privateKey;
  const ts2 = String(Date.now());
  assert.strictEqual(call({ "X-Client-Id": "pc", "X-Timestamp": ts2, "X-Signature": sign(ts2, other) }), 401);

  const old = String(Date.now() - 10 * 60 * 1000);
  assert.strictEqual(call({ "X-Client-Id": "pc", "X-Timestamp": old, "X-Signature": sign(old) }), 401);
  assert.strictEqual(call({}), 401);
});
