# API

- [Autenticação](#autenticação)
- [Formato bundle](#formato-bundle)
- [O que o server entende (e o que não)](#o-que-o-server-entende-e-o-que-não)
- [Rotas](#rotas)
- [Fluxo típico](#fluxo-típico)

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

Para o server, o relógio do PC só importa nessa janela de ±5 min contra replay. Quem ganha um conflito é decidido nos PCs, pela data de modificação dos arquivos.

## Formato bundle

Corpo binário (`application/octet-stream`) de `POST /upload` e das respostas de `GET /latest` e `POST /blobs`. É uma sequência de registros, sem cabeçalho geral:

```
┌──────────────┬────────────┬──────────────┬──────────────────────────┐
│ uint32 BE    │ nome UTF-8 │ uint32 BE    │ dados                    │
│ tam. do nome │ 1–512 B    │ tam. dados   │                          │
└──────────────┴────────────┴──────────────┴──────────────────────────┘  × N
```

## O que o server entende (e o que não)

| Item | Para o server |
|---|---|
| Manifesto | Bytes opacos. O cliente sela com `P1`+deflate (sem `SYNC_KEY`) ou `E1`+nonce+AES-256-GCM (com `SYNC_KEY`). |
| Blob | Bytes opacos, no mesmo formato. |
| Id do blob | 64 hex minúsculos. É um HMAC-SHA256 do conteúdo (com `SYNC_KEY`) ou o sha256 (sem). O server só confere o formato. |
| `refs` | Lista de ids que a versão usa. Serve para checar que nada falta e para apagar blobs órfãos. |
| `base` / `version` | Controle de concorrência: `version` precisa ser `base + 1`, e `base` precisa ser a versão mais nova. |

Por isso o server não faz merge, não descompacta e não valida conteúdo. Quem garante a integridade é o cliente: GCM autentica cada blob, e o sha256 do conteúdo vai no manifesto cifrado.

## Rotas

### `GET /latest?since=N`

| Status | Corpo |
|---|---|
| `204` | A versão mais nova é `N`, ou ainda não há nenhuma. |
| `200` | Bundle com um único registro `manifest`. |

O cabeçalho `X-Version-Id` vem sempre: o id da versão mais nova, ou vazio se o server não tem nenhuma. A comparação é de **igualdade**, e não `<=`: se o banco for recriado e os ids recomeçarem, o PC ainda busca.

### `POST /blobs`

Corpo: `{"ids": ["<64 hex>", …]}` (JSON, até 20000 itens; o cliente manda lotes de 500). Resposta: bundle com os blobs encontrados, cada registro com nome = id. Os ids que o server não tem simplesmente não aparecem.

### `POST /upload`

Corpo: bundle com, nesta ordem:

| Registro | Conteúdo |
|---|---|
| `meta.json` | JSON `{ "base": 21, "version": 22, "refs": ["<id>", …] }`. Use `base: null` e `version: 1` num server vazio. |
| `manifest` | Manifesto selado (até 20 MB). |
| `<id>` … | Só os blobs que o server ainda não tem. Todo id enviado precisa estar em `refs`. |

Exige `Content-Type: application/octet-stream` e `Content-Length`.

O server, numa transação com `LOCK TABLE`:
1. confere se `base` é a versão mais nova; senão, responde `409 conflict`;
2. confere se toda ref está no envio ou no banco; senão, responde `409 missing`;
3. grava os blobs novos e a versão;
4. apaga versões além das 3 últimas e os blobs que nenhuma usa.

| Status | Corpo |
|---|---|
| `201` | `{ "versionId": 22, "refCount": 580, "newBytes": 4924, "prunedBlobs": 1 }` |
| `400` | `{ "error": "..." }`: bundle mal formado, versão fora de sequência, blob fora das refs. |
| `409` | `{ "conflict": true, "latest": 23 }`: outro PC enviou antes. Busque a versão nova, refaça o merge e envie com `base: 23`. |
| `409` | `{ "missing": ["<id>", …] }`: reenvie incluindo esses blobs. |
| `413` | Corpo maior que `MAX_UPLOAD_MB`. |
| `415` | Content-Type diferente: cliente antigo. |

### `GET /versions`

```json
{
  "blobs": { "count": 573, "storedBytes": 6427648 },
  "versions": [
    { "id": 22, "clientId": "pc-desktop-a8f3", "createdAt": "2026-10-17T16:02:11.000Z",
      "refs": 580, "manifestBytes": 30912 }
  ]
}
```

## Fluxo típico

```
PC                                          SERVER
GET /latest?since=20            ─────►
                                ◄─────      200, X-Version-Id: 21, bundle[manifest]
(abre o manifesto, merge de 3 vias com a base 20 e o estado local)
POST /blobs {ids:[a1,b7]}       ─────►
                                ◄─────      bundle[a1, b7]
POST /upload [meta {base:21, version:22}, manifest, c9] ──►
                                ◄─────      201 {versionId: 22}
(aplica o resultado na pasta do Claude; a base passa a ser a 22)
```
