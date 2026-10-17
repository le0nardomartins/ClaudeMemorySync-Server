# Documentação do Claude Memory Sync (server)

Esta pasta tem dois usos:

1. **Documentação** do server, para quem vai fazer o deploy, operar ou modificar.
2. **Skill do Claude Code** (`claude-memory-server`). O `SKILL.md` faz o Claude saber fazer o deploy na Railway, autorizar e revogar PCs, consultar o banco e diagnosticar erros.

## Índice

| Documento | Para quem | Conteúdo |
|---|---|---|
| [deploy.md](deploy.md) | Quem vai subir o server | Railway passo a passo, outros provedores, atualização e migrações |
| [api.md](api.md) | Quem vai integrar ou contribuir | Assinatura Ed25519, formato bundle, cada rota com exemplos |
| [operations.md](operations.md) | Quem mantém o server | Banco, backup, tamanho, zerar histórico, revogar PCs, diagnóstico |
| [SKILL.md](SKILL.md) | O Claude | Regras e roteiro que o Claude segue ao usar a skill |

O cliente (que roda em cada PC) tem a própria pasta `docs/`, no repositório [memory-interconnection-claude](https://github.com/le0nardomartins/memory-interconnection-claude/tree/main/docs).

## Instalar como skill

**Windows (PowerShell):**

```powershell
git clone --depth 1 https://github.com/le0nardomartins/backend-memory-interconnection-claude.git $env:TEMP\cms-server
Copy-Item -Recurse $env:TEMP\cms-server\docs $HOME\.claude\skills\claude-memory-server
Remove-Item -Recurse -Force $env:TEMP\cms-server
```

**macOS / Linux:**

```bash
git clone --depth 1 https://github.com/le0nardomartins/backend-memory-interconnection-claude.git /tmp/cms-server
cp -r /tmp/cms-server/docs ~/.claude/skills/claude-memory-server
rm -rf /tmp/cms-server
```

**Pelo próprio Claude:**

> Instale como skill a pasta `docs` do repositório https://github.com/le0nardomartins/backend-memory-interconnection-claude, com o nome `claude-memory-server`.

Exemplos de pedidos depois de instalada: *"suba o server do memory sync na Railway"*, *"autorize o meu notebook novo no server"*, *"quanto espaço o banco do sync está usando?"*.
