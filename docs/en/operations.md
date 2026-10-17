# Operations

- [Accessing the database](#accessing-the-database)
- [Useful queries](#useful-queries)
- [Backups](#backups)
- [Resetting the history](#resetting-the-history)
- [Authorizing and revoking machines](#authorizing-and-revoking-machines)
- [Diagnostics](#diagnostics)

> With `SYNC_KEY` on the machines, the database only holds encrypted data. Without it, it contains the machines' API keys: in that case, treat dumps with the same care as a `.env` file.

## Accessing the database

With the Railway CLI, without exposing the database:

```bash
railway link            # pick the project
railway connect Postgres
```

Or temporarily enable Postgres's **TCP Proxy** in the dashboard and use `DATABASE_PUBLIC_URL` from a local client. Disable it when you're done.

## Useful queries

```sql
-- Stored versions
SELECT id, client_id, created_at, cardinality(refs) AS files,
       pg_size_pretty(length(manifest)::bigint) AS manifest
  FROM cms_versions ORDER BY id DESC;

-- Space used
SELECT pg_size_pretty(pg_total_relation_size('cms_blobs'))    AS blobs,
       pg_size_pretty(pg_total_relation_size('cms_versions')) AS versions,
       (SELECT count(*) FROM cms_blobs)                        AS n_blobs;

-- Largest blobs
SELECT id, pg_size_pretty(length(data)::bigint) AS size, created_at
  FROM cms_blobs ORDER BY length(data) DESC LIMIT 20;

-- Is the data encrypted? (E1 = AES-256-GCM, P1 = only compressed)
SELECT convert_from(substring(data from 1 for 2), 'SQL_ASCII') AS format, count(*)
  FROM cms_blobs GROUP BY 1;
```

The server can't read paths or content. To see what's in a version, use the client on a machine.

## Backups

```bash
pg_dump "$DATABASE_PUBLIC_URL" -Fc -f memory-$(date +%Y%m%d).dump
# restore
pg_restore -d "$TARGET_DATABASE_URL" --clean memory-YYYYMMDD.dump
```

A backup is only useful together with the machines' `SYNC_KEY`. Also remember that each machine already keeps the full version from its last sync (`SHARING_MEMORY/`), plus `.sync_trash/` and `.sync_conflicts/`.

## Resetting the history

Use it when rotating the `SYNC_KEY`, after restoring the wrong backup, or to start over.

```sql
TRUNCATE cms_versions, cms_blobs;
```

On the next sync, the first machine to run uploads everything again (version 1), and the others receive and merge with their local base. Nothing is lost on the machines: resetting the server deletes nobody's files.

To **remove a file** from every machine, you don't need to touch the server: just delete it on one machine. The 3-way merge propagates the deletion.

## Authorizing and revoking machines

`CLIENT_PUBLIC_KEYS` is the only access list.

| Action | How |
|---|---|
| Authorize | Append `name:base64` (generated with `keygen` on the machine), separated by a comma. |
| Revoke | Remove the entry. If the machine was compromised, also rotate the `SYNC_KEY` on the other machines and reset the history. |
| Rotate a machine's key | Generate a new pair on the machine, replace its `.env` and the entry here. |

Saving the variable restarts the server on Railway, and the `PCs autorizados: ...` log line confirms the list.

## Diagnostics

Server log messages are in Portuguese:

| Server log | Meaning |
|---|---|
| `Falha ao iniciar: CLIENT_PUBLIC_KEYS vazia` | The variable is missing. |
| `Falha ao iniciar: Defina DATABASE_URL ou ...` | The database variable is missing. |
| `[migração] tabelas do protocolo antigo removidas` | First start after upgrading from the server-side-merge protocol. Normal, happens once. The machines upload everything again. |
| `[recusado] IP (se apresentou como "x") ...` | Request without a valid signature. If `x` is one of your machines: wrong key, wrong name or wrong clock. |
| `[bloqueado] IP após 10 falhas` | IP blocked for 15 min. |
| `POST /upload -> 409` followed by `-> 201` from the same machine | Normal: two machines synced together, and one redid the merge. |
| `POST /upload -> 400 ... formato antigo` or `-> 415` | Old client. Update that machine's client. |
| `[pg] conexão ociosa falhou` | Postgres restarted. The pool reconnects on its own. |
| `[erro] ...` with `500` to the client | Unexpected error. Open an issue with the log line. |

| The client sees | Server side |
|---|---|
| `não consegui falar com ...` | Service down, wrong domain, or waking from sleep (the client waits up to 120 s). |
| `HTTP 503 ocupado` | 2 heavy operations already running. The client retries next round. |
| `HTTP 413` | Raise `MAX_UPLOAD_MB` or sync less. |
| `outro PC enviou antes 5 vezes seguidas` | Many machines uploading at once. Resolves itself next round. |
