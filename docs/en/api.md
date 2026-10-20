# API

- [Authentication](#authentication)
- [Bundle format](#bundle-format)
- [What the server understands (and what it doesn't)](#what-the-server-understands-and-what-it-doesnt)
- [Routes](#routes)
- [Typical flow](#typical-flow)

## Authentication

Every request carries three headers:

| Header | Value |
|---|---|
| `X-Client-Id` | Machine name, the same one used in `CLIENT_PUBLIC_KEYS`. |
| `X-Timestamp` | Time in milliseconds (Unix). Accepted within ±5 min. |
| `X-Signature` | Ed25519 signature in base64 (64 bytes → 88 characters). |

Signed message (UTF-8, `\n`-separated):

```
METHOD
PATH_WITH_QUERY          e.g. /latest?since=21
TIMESTAMP                same value as X-Timestamp
SHA256_HEX(body)         empty body → sha256 of zero bytes
```

Each signature is valid **once**: the server remembers signatures from the last 5 minutes and rejects repeats.

Python example (what the client does):

```python
msg = f"{method}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode()
sig = base64.b64encode(private_key.sign(msg)).decode()
```

To the server, the machine's clock only matters for this ±5 min anti-replay window. Who wins a conflict is decided on the machines, by file modification time.

## Bundle format

Binary body (`application/octet-stream`) of `POST /upload` and of the `GET /latest` and `POST /blobs` responses. It's a sequence of records with no global header:

```
┌──────────────┬────────────┬──────────────┬──────────────────────────┐
│ uint32 BE    │ UTF-8 name │ uint32 BE    │ data                     │
│ name length  │ 1–512 B    │ data length  │                          │
└──────────────┴────────────┴──────────────┴──────────────────────────┘  × N
```

## What the server understands (and what it doesn't)

| Item | To the server |
|---|---|
| Manifest | Opaque bytes. The client seals it as `P1`+deflate (no `SYNC_KEY`) or `E1`+nonce+AES-256-GCM (with `SYNC_KEY`). |
| Blob | Opaque bytes, in the same format. |
| Blob id | 64 lowercase hex characters. An HMAC-SHA256 of the content (with `SYNC_KEY`) or its sha256 (without). The server only checks the format. |
| `refs` | The ids a version uses. Used to check nothing is missing and to delete orphan blobs. |
| `base` / `version` | Concurrency control: `version` must be `base + 1`, and `base` must be the newest version. |

That's why the server doesn't merge, decompress or validate content. Integrity is the client's job: GCM authenticates each blob, and the content's sha256 is in the encrypted manifest.

## Routes

### `GET /latest?since=N`

| Status | Body |
|---|---|
| `204` | The newest version is `N`, or there isn't one yet. |
| `200` | A bundle with a single `manifest` record. |

The `X-Version-Id` header is always present: the newest version's id, or empty if the server has none. The comparison is **equality**, not `<=`: if the database is recreated and ids restart, the machine still fetches.

### `POST /blobs`

Body: `{"ids": ["<64 hex>", …]}` (JSON, up to 20000 items; the client sends batches of 500). Response: a bundle with the blobs found, each record named by its id. Ids the server doesn't have are simply absent.

### `POST /upload`

Body: a bundle with, in this order:

| Record | Content |
|---|---|
| `meta.json` | JSON `{ "base": 21, "version": 22, "refs": ["<id>", …] }`. Use `base: null` and `version: 1` on an empty server. |
| `manifest` | Sealed manifest (up to 20 MB). |
| `<id>` … | Only the blobs the server doesn't have yet. Every id sent must be in `refs`. |

Requires `Content-Type: application/octet-stream` and `Content-Length`.

The server, inside a transaction with `LOCK TABLE`:
1. checks that `base` is the newest version; otherwise it answers `409 conflict`;
2. checks that every ref is in the upload or in the database; otherwise it answers `409 missing`;
3. stores the new blobs and the version;
4. deletes versions beyond the last 3 and blobs none of them use.

| Status | Body |
|---|---|
| `201` | `{ "versionId": 22, "refCount": 580, "newBytes": 4924, "prunedBlobs": 1 }` |
| `400` | `{ "error": "..." }`: malformed bundle, out-of-sequence version, blob outside refs. |
| `409` | `{ "conflict": true, "latest": 23 }`: another machine uploaded first. Fetch the new version, redo the merge and send with `base: 23`. |
| `409` | `{ "missing": ["<id>", …] }`: resend including those blobs. |
| `413` | Body larger than `MAX_UPLOAD_MB`. |
| `415` | Different Content-Type: an old client. |

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

## Typical flow

```
MACHINE                                     SERVER
GET /latest?since=20            ─────►
                                ◄─────      200, X-Version-Id: 21, bundle[manifest]
(opens the manifest, 3-way merge with base 20 and the local state)
POST /blobs {ids:[a1,b7]}       ─────►
                                ◄─────      bundle[a1, b7]
POST /upload [meta {base:21, version:22}, manifest, c9] ──►
                                ◄─────      201 {versionId: 22}
(applies the result to Claude's folder; the base becomes 22)
```
