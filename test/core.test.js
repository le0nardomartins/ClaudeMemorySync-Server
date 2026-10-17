const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const bundle = require("../src/bundle");
const { loadPublicKeys, createAuthMiddleware, signedMessage } = require("../src/auth");

const id = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Monta o corpo de um POST /upload como o cliente faz
function uploadBody({ base = null, version = (base ?? 0) + 1, refs = [], blobs = {}, manifest = "selado" } = {}) {
  return bundle.encode([
    { name: "meta.json", data: Buffer.from(JSON.stringify({ base, version, refs })) },
    { name: "manifest", data: Buffer.from(manifest) },
    ...Object.entries(blobs).map(([name, data]) => ({ name, data: Buffer.from(data) })),
  ]);
}

test("bundle: ida e volta, e recusa dados truncados", () => {
  const recs = [{ name: "a", data: Buffer.from([1, 2, 3]) }, { name: "b".repeat(64), data: Buffer.alloc(0) }];
  const back = bundle.decode(bundle.encode(recs));
  assert.deepStrictEqual(back.map((r) => [r.name, [...r.data]]), [["a", [1, 2, 3]], ["b".repeat(64), []]]);
  assert.throws(() => bundle.decode(bundle.encode(recs).subarray(0, 10)), bundle.BadPackage);
});

test("upload: lê meta, manifesto e blobs referenciados", () => {
  const a = id("a"), b = id("b");
  const up = bundle.readUpload(uploadBody({ base: 4, refs: [a, b], blobs: { [a]: "AAA" } }));
  assert.strictEqual(up.base, 4);
  assert.strictEqual(up.version, 5);
  assert.deepStrictEqual([...up.refs].sort(), [a, b].sort());
  assert.strictEqual(up.blobs.get(a).toString(), "AAA");
  assert.strictEqual(up.manifest.toString(), "selado");

  const first = bundle.readUpload(uploadBody({ refs: [a], blobs: { [a]: "x" } }));
  assert.strictEqual(first.base, null);
  assert.strictEqual(first.version, 1);
});

test("upload: recusa formato antigo, versão fora de sequência, blob fora das refs e id inválido", () => {
  const a = id("a");
  const old = bundle.encode([{ name: "manifest.json", data: Buffer.from("{}") }]);
  assert.throws(() => bundle.readUpload(old), /formato antigo/);
  assert.throws(() => bundle.readUpload(uploadBody({ base: 2, version: 9, refs: [a] })), /base \+ 1/);
  assert.throws(() => bundle.readUpload(uploadBody({ refs: [a], blobs: { [id("z")]: "z" } })), /fora das refs/);
  assert.throws(() => bundle.readUpload(uploadBody({ refs: ["../x"] })), /refs inválidas/);
  assert.throws(() => bundle.readUpload(uploadBody({ refs: [a], manifest: "" })), /manifesto/);
});

test("auth: aceita assinatura válida uma vez, recusa replay, chave errada e horário velho", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const auth = createAuthMiddleware(loadPublicKeys(`pc:${pub}`));

  const call = (headers, body = Buffer.from("corpo")) => {
    let status = 200;
    const req = { method: "POST", originalUrl: "/upload", body, get: (h) => headers[h] };
    const res = { status: (s) => { status = s; return { json: () => {} }; } };
    let passed = false;
    auth(req, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  const sign = (ts, key = privateKey, body = Buffer.from("corpo")) =>
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
