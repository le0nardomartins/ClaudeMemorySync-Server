# Claude Memory Sync documentation (server)

[Português](../README.md) · **English**

This folder has two uses:

1. **Documentation** for the server, for anyone who deploys, runs or changes it.
2. **A Claude Code skill** (`claude-memory-server`). `SKILL.md` teaches Claude to deploy on Railway, authorize and revoke machines, query the database and diagnose errors.

## Index

| Document | For | Contents |
|---|---|---|
| [deploy.md](deploy.md) | Whoever deploys the server | Railway step by step, other hosts, updates and migrations |
| [api.md](api.md) | Integrators and contributors | Ed25519 signing, bundle format, every route with examples |
| [operations.md](operations.md) | Whoever runs the server | Database, backups, size, resetting history, revoking machines, diagnostics |
| [SKILL.md](SKILL.md) | Claude | Rules and playbook Claude follows when using the skill |

The client (which runs on each machine) has its own `docs/en/` folder in [ClaudeMemorySync](https://github.com/le0nardomartins/ClaudeMemorySync/tree/main/docs/en). It does the 3-way merge and encryption, and also documents the serverless Git mode.

## Install as a skill

**Windows (PowerShell):**

```powershell
git clone --depth 1 https://github.com/le0nardomartins/ClaudeMemorySync-Server.git $env:TEMP\cms-server
Copy-Item -Recurse $env:TEMP\cms-server\docs\en $HOME\.claude\skills\claude-memory-server
Remove-Item -Recurse -Force $env:TEMP\cms-server
```

**macOS / Linux:**

```bash
git clone --depth 1 https://github.com/le0nardomartins/ClaudeMemorySync-Server.git /tmp/cms-server
cp -r /tmp/cms-server/docs/en ~/.claude/skills/claude-memory-server
rm -rf /tmp/cms-server
```

**Ask Claude:**

> Install the `docs/en` folder from https://github.com/le0nardomartins/ClaudeMemorySync-Server as a skill named `claude-memory-server`.

Example requests once installed: *"deploy the memory sync server on Railway"*, *"authorize my new laptop on the server"*, *"how much space is the sync database using?"*.
