// Gera um par de chaves Ed25519 para um PC.
//
//   npm run keygen -- pc-casa
//
// A chave PRIVADA vai para o .env daquele PC (nunca para a Railway).
// A linha PÚBLICA vai para CLIENT_PUBLIC_KEYS na Railway (separe PCs com vírgula).

const crypto = require("crypto");

const clientId = (process.argv[2] || "").trim();
if (!/^[\w.-]{1,64}$/.test(clientId)) {
  console.error("Uso: npm run keygen -- <nome-do-pc>   (letras, números, ponto, hífen, _)");
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const priv = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("base64");

console.log("# .env do PC (privado, não compartilhe):");
console.log(`CLIENT_ID=${clientId}`);
console.log(`CLIENT_PRIVATE_KEY=${priv}`);
console.log("");
console.log("# Railway -> CLIENT_PUBLIC_KEYS (pode ser público):");
console.log(`${clientId}:${pub}`);
