# Deploy

- [Railway](#railway)
- [Other hosts](#other-hosts)
- [Updating](#updating)
- [Migrations](#migrations)

## Railway

### 1. Project and service

1. Fork this repository (or use the original).
2. On Railway, choose **New Project → Deploy from GitHub repo** and select the repository.
3. Railway reads `railway.json`:
   - builds from the `Dockerfile`;
   - keeps 1 replica;
   - restarts if the server crashes (`ON_FAILURE`, up to 10 times);
   - **sleeps when idle** (`sleepApplication: true`).

The first deploy fails until the variables exist. That's expected.

### 2. Postgres

**New → Database → PostgreSQL** in the same project. Don't generate a public domain for the database: the server uses the private network (`postgres.railway.internal`), with no SSL and no exposure.

### 3. Server service variables

In the server service's **Variables** (not Postgres's):

```ini
DATABASE_URL=${{Postgres.DATABASE_URL}}
CLIENT_PUBLIC_KEYS=pc-laptop-x7k2:AAAA...,pc-desktop-a8f3:BBBB...
```

- `${{Postgres.DATABASE_URL}}` is a **reference**: Railway fills it in and keeps it updated if the password changes.
- Public keys are generated on each machine (see the README, "Authorizing machines").
- Optional: `MAX_UPLOAD_MB` (default 50) and `DATABASE_SSL=true` (only when using the database's public URL).

### 4. Domain

Under **Settings → Networking → Generate Domain** you get a URL like `https://your-app.up.railway.app`. It goes into `SERVER_URL` in each machine's `.env`.

### 5. Check

In the deploy logs:

```
memory server na porta 8080 | PCs autorizados: pc-laptop-x7k2, pc-desktop-a8f3
```

Then run `python src/main.py` on a machine. The server log should show `POST /upload -> 201`.

### Healthcheck

Keep Railway's healthcheck **off**. Every route requires a signature, so an HTTP healthcheck would get `401`. It would also keep the service awake and defeat sleep. `restartPolicyType` already covers crashes.

## Other hosts

Anything that runs a container and has Postgres 13+ works.

```bash
docker build -t claude-memory-server .
docker run -d -p 8080:8080 \
  -e PORT=8080 \
  -e DATABASE_URL=postgres://user:password@host:5432/db \
  -e CLIENT_PUBLIC_KEYS="pc-a:AAAA...,pc-b:BBBB..." \
  claude-memory-server
```

Requirements:
- **HTTPS in front.** The client refuses `http://` except `localhost`. Use the host's TLS or a reverse proxy (Caddy, nginx).
- **Exactly one proxy** between the internet and the server. The server sets `trust proxy = 1` to get the real IP used for blocking. With more layers, adjust that value in `server.js`.
- **Memory:** 512 MB is enough (heap capped at 384 MB).

## Updating

1. Push to the configured branch. Railway rebuilds and deploys, and the new server only takes traffic once it's up.
2. If the change altered the protocol, update the client on **every** machine: `git pull` + restart the sync. Until then, outdated machines get `415` and don't sync, but nothing is corrupted.

## Migrations

`db.migrate()` runs on every start and is idempotent:

1. If it finds tables from earlier protocols (`memory_versions`, `blobs`, from when the merge ran on the server), it **drops** them. Their data doesn't fit the new, encrypted protocol.
2. Creates `cms_blobs` and `cms_versions` if they don't exist.

No data is lost on the machines: each one keeps the base from its last sync (`SHARING_MEMORY/`), and the first one to run the new client uploads everything again, encrypted. To keep the old database state anyway, take a `pg_dump` before deploying (see [operations.md](operations.md#backups)).
