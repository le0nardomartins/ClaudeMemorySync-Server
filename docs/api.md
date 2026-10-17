# API

- [Autenticação](#autenticação)
- [Formato bundle](#formato-bundle)
- [Manifesto](#manifesto)
- [Rotas](#rotas)
- [Fluxo típico](#fluxo-típico)
- [Exclusões](#exclusões)

## Autenticação

Toda requisição leva três cabeçalhos:

| Cabeçalho | Valor |
|---|---|
| `X-Client-Id` | Nome do PC, igual ao usado em `CLIENT_PUBLIC_KEYS`. |
| `X-Timestamp` | Horário em milissegundos (Unix). Aceito com até ±5 min de diferença. |
| `X-Signature` | Assinatura Ed25519 em base64 (64 bytes → 88 caracteres). |

Mensagem assinada (UTF-8, separada por `\n`):

```
MÉTODO
CAMINHO_COM_QUERY        ex.: /latest?since=21
TIMESTAMP                o mesmo valor de X-Timestamp
SHA256_HEX(corpo)        corpo vazio → sha256 de zero bytes
```

Cada assinatura vale **uma vez**: o server lembra as assinaturas dos últimos 5 minutos e recusa repetições.

Exemplo em Python (é o que o cliente faz):

```python
msg = f"{method}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode()
sig = base64.b64encode(private_key.sign(msg)).decode()
```

## Formato bundle

Corpo binário (`application/octet-stream`) de `POST /upload` e das respostas de `GET /latest` e `POST /blobs`. É uma sequência de registros, sem cabeçalho geral:

```
┌──────────────┬────────────┬──────────────┬──────────────────────────┐
│ uint32 BE    │ nome UTF-8 │ uint32 BE    │ dados (deflate-raw)      │
│ tam. do nome │ 1–512 B    │ tam. dados   │                          │
└──────────────┴────────────┴──────────────┴──────────────────────────┘  × N
```

- O nome é `manifest.json` ou o **sha256 (hex, minúsculo) do conteúdo descompactado**.
- Os dados são DEFLATE sem cabeçalho zlib (`zlib.deflateRawSync`, ou `zlib.compressobj(9, zlib.DEFLATED, -15)` no Python).
- Os blobs são guardados no banco exatamente como chegam e devolvidos sem recompactar.

## Manifesto

```json
{
  "version": 21,
  "files": {
    "CLAUDE.md":                  { "sha256": "9f2c…", "size": 8123,  "mtime": 1760700000.5 },
    "skills/minha-skill/SKILL.md": { "sha256": "41ab…", "size": 2210,  "mtime": 1760690000.0 }
  }
}
```

| Campo | Regra |
|---|---|
| Caminho | Posix relativo e no máximo 512 caracteres. Não pode ter `..`, `.`, segmento vazio, `\`, `/` no início nem letra de drive. |
| `sha256` | 64 caracteres hex, do conteúdo descompactado. |
| `size` | Bytes descompactados. A soma de todos os arquivos vai até 200 MB. |
| `mtime` | Segundos Unix (pode ter fração). Decide quem ganha num conflito. |
| `version` | Preenchido pelo server, ignorado no upload. |

No máximo 5000 arquivos por manifesto.

## Rotas

### `POST /upload`

Corpo: bundle com `manifest.json` como **primeiro** registro, seguido dos conteúdos que o server ainda não tem. Exige `Content-Type: application/octet-stream` e `Content-Length`.

O server, nesta ordem:
1. descompacta cada conteúdo com teto, confere tamanho e hash e recusa conteúdo fora do manifesto;
2. descarta do manifesto os caminhos excluídos (veja [Exclusões](#exclusões));
3. dentro de uma transação com lock, confere se todo hash do manifesto está no upload ou no banco;
4. mescla com a versão anterior, lendo só os arquivos que mudaram nos dois lados;
5. se o conteúdo final é igual ao da versão anterior, não cria versão;
6. senão, grava os blobs novos e a versão nova, apaga versões além das 3 últimas e os blobs órfãos.

| Status | Corpo |
|---|---|
| `201` | `{ "versionId": 22, "fileCount": 580, "totalBytes": 16719660, "newBytes": 4924, "unchanged": false }` |
| `201` | `{ …, "unchanged": true }`: nada mudou, e `versionId` é a versão atual. |
| `400` | `{ "error": "hash não confere: …" }` e outros erros de validação. |
| `409` | `{ "error": "faltam N arquivo(s) no envio", "missing": ["sha256", …] }`. Reenvie incluindo esses conteúdos. |
| `413` | Corpo maior que `MAX_UPLOAD_MB`. |
| `415` | Content-Type diferente: cliente antigo (formato zip). |

### `GET /latest?since=N`

| Status | Corpo |
|---|---|
| `204` | A versão mais nova é `N` (ou o banco está vazio). |
| `200` | Bundle com um único registro `manifest.json`. O cabeçalho `X-Version-Id` traz o id da versão. |

A comparação é de **igualdade**, e não `<=`: se o banco for recriado e os ids recomeçarem, o PC ainda baixa.

### `POST /blobs`

Corpo: `{"hashes": ["sha256", …]}` (JSON, até 5000 itens). Resposta: bundle com os conteúdos encontrados. Os hashes que o server não tem simplesmente não aparecem.

### `GET /versions`

```json
{
  "blobs": { "count": 573, "storedBytes": 6427648 },
  "versions": [
    { "id": 21, "clientId": "pc-desktop-a8f3", "createdAt": "2026-10-17T16:02:11.000Z",
      "fileCount": 581, "totalBytes": 16719660, "manifestBytes": 30912 }
  ]
}
```

## Fluxo típico

```
PC                                      SERVER
GET /latest?since=20         ─────►
                             ◄─────     200, X-Version-Id: 21, bundle[manifest]
(compara com os hashes locais)
POST /blobs {hashes:[a1,b7]} ─────►
                             ◄─────     bundle[a1, b7]
(monta SHARING_MEMORY e mescla)
POST /upload bundle[manifest, c9] ──►
                             ◄─────     201 {versionId: 22}
```

## Exclusões

O server descarta do manifesto, mesmo se o cliente mandar:
- qualquer caminho com um segmento `node_modules`, `.git` ou `__pycache__`;
- qualquer caminho que comece com `skills/synced/`.

A regra fica em `src/bundle.js` (`isExcluded`) e é espelhada em `remote_client.py` (`is_excluded`) no cliente.
