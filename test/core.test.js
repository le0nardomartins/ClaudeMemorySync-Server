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
