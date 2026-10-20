# Claude Memory Sync - Server

[Português](README.md) · **English**

Server for **Claude Memory Sync**, which keeps Claude Code skills, agents, commands, hooks, `CLAUDE.md`, settings, plugins and MCP servers identical across several computers.

Each machine runs the [client](https://github.com/le0nardomartins/ClaudeMemorySync). The client does the 3-way merge and **encrypts everything before sending**. This server is just **version storage**:
- it keeps sealed manifests and blobs without being able to read them (not even file names);
- it only accepts a new version if it was built on the latest one, so no machine overwrites another.

- **Stack:** Node 22, Express 5 and Postgres, packaged with Docker and ready for [Railway](https://railway.com). Just two dependencies: `express` and `pg`.
- **Cheap:** only changes travel, each piece of content is stored once, only the last 3 versions are kept, there's no merge or decompression on the server, and the service sleeps between rounds.
- **Locked down:** every route requires an Ed25519 signature from an authorized machine, and a leaked database only exposes encrypted data.

> Don't want to run a server? The client can also sync through a **private Git repository**, with no deploy at all. See [Git mode](https://github.com/le0nardomartins/ClaudeMemorySync/blob/main/docs/en/git-backend.md). This server is still the default mode.

---

## Contents

- [How it works](#how-it-works)
- [Deploying on Railway](#deploying-on-railway)
- [Authorizing machines](#authorizing-machines)
- [Environment variables](#environment-variables)
- [API](#api)
- [Database](#database)
- [Security](#security)
- [Costs](#costs)
- [Logs](#logs)
- [Running locally and tests](#running-locally-and-tests)
- [Layout](#layout)
- [Full docs and Claude skill](#full-docs-and-claude-skill)

---

## How it works

```
 Machine A                           SERVER                                Machine B
 ─────────                           ──────                                ─────────
 GET /latest  ◄──────────────  sealed manifest of version N
 (3-way merge on the machine, encrypts the result)
 POST /upload ──────────────►  base == N (the newest)?
 base=N, version=N+1             yes → stores version N+1 + new blobs
 refs + new blobs                no  → 409 conflict: the machine fetches and redoes the merge
                                 drops versions beyond the last 3 and orphan blobs
                                                    ◄──────────────  GET /latest?since=N
                               sealed manifest of N+1   ───────────►
                                                    ◄──────────────  POST /blobs {ids}
                               only the missing blobs   ───────────►
```

- **Sealed manifest:** the version's file list, encrypted by the machine. The server stores and returns the bytes without opening them.
- **Blob:** one encrypted piece of content, identified by a 64-hex id computed on the machine (HMAC-SHA256 keyed with the `SYNC_KEY`). The same content at several paths or in several versions takes one blob.
- **refs:** the list of ids a version uses. It's the only thing the server understands: it checks nothing is missing and deletes blobs no version uses.
- **Version:** a sequential number. It stops a machine from uploading on top of a version it hasn't seen. Who wins a conflict is decided on the machines, by file modification time (carried, encrypted, in the manifest).

Protocol details in [docs/en/api.md](docs/en/api.md).

## Deploying on Railway

**1. Create the project.** On Railway: **New Project → Deploy from GitHub repo**, then pick this repository (or your fork). `railway.json` tells Railway to build from the `Dockerfile`.

**2. Add Postgres** to the same project: **New → Database → PostgreSQL**. Don't generate a public domain for it: the server connects over the private network.

**3. Set the variables** on the server service (not on Postgres):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference: Railway fills it in and keeps it updated) |
| `CLIENT_PUBLIC_KEYS` | Machines' public keys. See [Authorizing machines](#authorizing-machines). |

**4. Generate a public domain** under **Settings → Networking → Generate Domain**. That URL is the `SERVER_URL` in each machine's `.env`.

**5. Check the deploy logs.** You should see:

```
memory server na porta 8080 | PCs autorizados: pc-laptop-x7k2
```

Tables are created on first start. For other hosts (Fly.io, Render, a VPS), see [docs/en/deploy.md](docs/en/deploy.md).

## Authorizing machines

Each machine has an Ed25519 key pair. The **private** key stays in that machine's `.env`. The **public** key goes to the server.

Generate the pair on the machine itself, with the client:

```bash
python src/components/remote_client.py keygen pc-laptop-x7k2
```

Or with this repository:

```bash
npm run keygen -- pc-laptop-x7k2
```

Copy the `pc-laptop-x7k2:<base64>` line into `CLIENT_PUBLIC_KEYS`. With several machines, separate them with commas:

```
CLIENT_PUBLIC_KEYS=pc-laptop-x7k2:AAAA...,pc-desktop-a8f3:BBBB...
```

To **revoke** a machine, delete its entry. Railway restarts the server when you save the variable.

The `SYNC_KEY` (encryption) **never** goes through the server: it only lives in the machines' `.env` files.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes* | — | Postgres connection. *Or `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`. |
| `CLIENT_PUBLIC_KEYS` | yes | — | `name:base64,name:base64`. The server won't start if it's empty. |
| `MAX_UPLOAD_MB` | no | `50` | Max body size for `/upload` and `/blobs`. |
| `DATABASE_SSL` | no | `false` | `true` only when connecting through Postgres's public URL. |
| `PORT` | no | `3000` | Set by Railway. |

Commented template in [`.env.example`](.env.example).

## API

Every route requires the `X-Client-Id`, `X-Timestamp` and `X-Signature` headers. Without them, or with an invalid signature, the response is `401`. That includes routes that don't exist.

| Route | Body | Response |
|---|---|---|
| `GET /latest?since=N` | — | `204` if the newest is `N` (or there's none). Otherwise a bundle with the sealed manifest. `X-Version-Id` always present. |
| `POST /blobs` | JSON `{ "ids": [...] }` (up to 20000) | Bundle with the blobs found. |
| `POST /upload` | Bundle: `meta.json` `{ base, version, refs }` + sealed manifest + new blobs | `201 { versionId, refCount, newBytes, prunedBlobs }`, `409 { conflict: true, latest }` if another machine got there first, `409 { missing: [...] }` if a blob is missing, `415` for an old client |
| `GET /versions` | — | History (id, machine, date, ref count) and total blob storage. |

Bundle format, signing rules and examples: [docs/en/api.md](docs/en/api.md).

## Database

| Table | Row | Columns |
|---|---|---|
| `cms_blobs` | One encrypted piece of content | `id` (PK), `data` (`STORAGE EXTERNAL`: already compressed and encrypted), `created_at` |
| `cms_versions` | One version | `id`, `client_id`, `created_at`, `manifest` (sealed), `refs` (`TEXT[]`) |

- Only the **3 newest versions** are kept. On each upload, blobs none of them use are deleted.
- Concurrent uploads are serialized with `LOCK TABLE`. Only one built on the newest version is accepted, and the other gets `409 conflict` and redoes the merge on its machine.
- On the first start after upgrading from the old protocol (merge on the server), the old tables (`memory_versions`, `blobs`) are **dropped**. The machines keep their base locally and upload everything again, encrypted, on the next round.

Maintenance (reset, backups, size): [docs/en/operations.md](docs/en/operations.md).

## Security

Defenses in order, cheapest first. A request that fails one step never reaches the next:

1. **IP block:** 10 authentication failures in 15 min → `429` until the window ends.
2. **Headers:** unknown client, time outside ±5 min or malformed signature → `401`, without reading the body.
3. **Size:** `POST /upload` and `/blobs` require `Content-Length` (no *chunked*). Above `MAX_UPLOAD_MB` → `413`. Other routes accept no body.
4. **Concurrency:** at most 2 heavy requests at once (`503` beyond that).
5. **Ed25519 signature:** covers `METHOD\nPATH\nTIMESTAMP\nSHA256(body)`. A replayed signature is rejected.
6. **Bundle:** rejects duplicate records, malformed ids, blobs outside `refs`, out-of-sequence versions and the old format.

Also:
- **No readable content in the database.** With `SYNC_KEY` on the machines, the server only sees encrypted bytes, opaque ids and sizes.
- An unknown route returns `401`, so nobody can discover which routes exist.
- Security headers, no `X-Powered-By` and no ETag.
- Timeouts against slow connections (slowloris) and `statement_timeout` on Postgres.
- Every in-memory structure is capped, and the heap is limited to 384 MB.
- The container runs without root and without npm, and dependencies are pinned to exact versions.

## Costs

| Choice | Effect |
|---|---|
| Only changes are sent | One edited line in a skill becomes an upload of a few KB. |
| Deduplication by id | Repeated content, across paths or versions, takes one blob. |
| 3 versions + blob pruning | The database stays close to the size of one compressed version. |
| No merge or decompression on the server | Minimal CPU and RAM per request. |
| `sleepApplication: true` | With no traffic for ~10 min the service sleeps and stops billing CPU/RAM. Clients run every 15 min. |
| `node_modules` and `skills/synced` excluded on the client | Reinstallable dependencies use neither database nor network. |

The first request after the service sleeps takes a few extra seconds. The client waits up to 120 s.

## Logs

Log messages are in Portuguese.

```
memory server na porta 8080 | PCs autorizados: pc-laptop-x7k2, pc-desktop-a8f3
[pc-laptop-x7k2] 177.x.x.x GET /latest -> 204 | ... | PC já está na versão mais nova
[pc-laptop-x7k2] 177.x.x.x POST /upload -> 201 | recebido 4.1 KB | ... | versão 19 salva: 580 blobs referenciados, 0.1 KB novos, 1 antigos apagados
[pc-desktop-a8f3] 189.x.x.x GET /latest -> 200 | ... | enviou o manifesto da versão 19
[pc-desktop-a8f3] 189.x.x.x POST /blobs -> 200 | ... | 1 de 1 blob(s) pedidos
[pc-desktop-a8f3] 189.x.x.x POST /upload -> 409 | ...                (another machine got there first; the client redoes the merge)
[recusado] 45.x.x.x (se apresentou como "pc-casa") GET /latest: cabeçalhos de autenticação inválidos
[bloqueado] 45.x.x.x após 10 falhas, por 15 min
```

Rejected attempts are logged only on the 1st failure and when the IP gets blocked, so an attack can't flood the logs.

There's no public healthcheck route, because every route requires a signature. Keep Railway's healthcheck off: `restartPolicyType: ON_FAILURE` already restarts the server if it crashes.

## Running locally and tests

```bash
npm ci
npm test                                   # bundle, upload, auth

# local server with a throwaway Postgres
docker run -d --name mem-pg -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres \
CLIENT_PUBLIC_KEYS="pc-test:<base64>" PORT=3999 npm start
```

On the client, use `SERVER_URL=http://127.0.0.1:3999`. Plain HTTP is only accepted for localhost.

## Layout

```
src/
  server.js      routes, defense order, shutdown
  auth.js        public keys, Ed25519 verification, anti-replay
  security.js    IP block, pre-checks, concurrency, headers, access log
  bundle.js      bundle format and upload parsing (meta, manifest, blobs)
  db.js          tables, migration, versioning with concurrency control, pruning, queries
scripts/keygen.js
test/core.test.js
docs/            full docs in Portuguese (also a Claude skill)
docs/en/         full docs in English (also a Claude skill)
Dockerfile · railway.json · .env.example
```

## Full docs and Claude skill

The [`docs/en/`](docs/en/) folder has the detailed documentation and is also a **Claude Code skill** (`claude-memory-server`). With it, Claude can deploy the server, authorize machines, query the database and diagnose problems.

```bash
git clone --depth 1 https://github.com/le0nardomartins/ClaudeMemorySync-Server.git /tmp/cms-server
cp -r /tmp/cms-server/docs/en ~/.claude/skills/claude-memory-server     # Windows: Copy-Item -Recurse
```

| Document | Contents |
|---|---|
| [docs/en/deploy.md](docs/en/deploy.md) | Railway step by step, other hosts, updating |
| [docs/en/api.md](docs/en/api.md) | Signing, bundle format, routes and examples |
| [docs/en/operations.md](docs/en/operations.md) | Database, backups, resetting history, revoking machines, diagnostics |
| [docs/en/SKILL.md](docs/en/SKILL.md) | Instructions Claude follows when using the skill |

## License

[MIT](LICENSE).
