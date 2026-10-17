---
name: claude-memory-server
description: Deploys, runs and troubleshoots the Claude Memory Sync server (Node + Postgres on Railway), an encrypted version store with concurrency control that holds Claude Code configuration from several machines. Use when the user asks to deploy or update the memory sync server, authorize or revoke a machine (CLIENT_PUBLIC_KEYS), check database size or history, reset the history (e.g. when rotating the SYNC_KEY), or investigate 401/409/413/415/429/503 errors seen by clients.
---

# Claude Memory Sync: server

Repositories:
- **Server** (this one): https://github.com/le0nardomartins/ClaudeMemorySync-Server
- **Client** (one per machine): https://github.com/le0nardomartins/ClaudeMemorySync. It ships the `claude-memory-sync` skill, does the 3-way merge, encrypts everything with the `SYNC_KEY`, and also supports a serverless mode backed by a private Git repository.

The server **doesn't merge and can't read content**. It stores sealed manifests and blobs, and only accepts a new version if it was built on the newest one (`409 conflict` otherwise).

Read on demand, in this folder:
- `deploy.md`: deploying on Railway or another host, updating
- `api.md`: the protocol, for debugging requests
- `operations.md`: SQL for queries and maintenance, backups, revocation, diagnostics

Server log messages are in Portuguese. `operations.md` lists each one with its meaning.

## Rules that always apply

1. **Data.** With `SYNC_KEY` on the machines, the database only holds encrypted data. Without it, it holds the user's API keys. Either way, never expose Postgres publicly and never share `DATABASE_URL`.
2. **Keys.** `CLIENT_PUBLIC_KEYS` holds only public keys, which may be shown. `CLIENT_PRIVATE_KEY` and `SYNC_KEY` never go to the server or into the chat.
3. **Confirm first** before a deploy, a push, changing a Railway variable, `TRUNCATE`, `DELETE`, or anything else irreversible. Back up (`pg_dump`, see `operations.md`) before touching data.
4. **Matching protocol.** Client and server must run the same protocol version. When one is updated, remind the user to update the other on every machine.
5. **Resetting the server deletes nothing on the machines.** Each one keeps its base locally and uploads everything again on the next round. To remove a file from every machine, deleting it on one machine is enough: don't touch the server for that.

## Tasks

### Initial deploy
Follow `deploy.md` → "Railway". The user has to:
- create the project and Postgres in the dashboard, or allow use of the Railway CLI;
- paste the public keys.

At the end, look for `memory server na porta ... | PCs autorizados: ...` in the log.

### Authorize a machine
1. On the machine, generate keys: `python src/components/remote_client.py keygen <name>` (client) or `npm run keygen -- <name>` (here).
2. Append `<name>:<base64>` to `CLIENT_PUBLIC_KEYS`, separated by a comma, without removing the others.
3. Railway restarts on its own. Check that the name appears in `PCs autorizados` in the log.

### Revoke a machine
Remove its entry from `CLIENT_PUBLIC_KEYS`. If the machine was compromised, walk the user through rotating the `SYNC_KEY` on every machine (client troubleshooting) and resetting the history (`operations.md`).

### Troubleshoot
Read the service logs (Railway dashboard or `railway logs`) and compare with `operations.md` → "Diagnostics". On the client side, the file is `sync.log`. A `409` followed by a `201` is normal.

### Query or maintain the database
Use the queries in `operations.md`. For one-off access, use `railway connect Postgres`. Prefer read-only queries and confirm any write.

### Update the server
1. Push to the repository: Railway deploys from the `Dockerfile`. Migrations run on startup (`db.migrate`).
2. Then ask the user to update the clients.
