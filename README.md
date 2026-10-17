# Claude Memory Sync - Server

Server do **Claude Memory Sync**, que mantém skills, agentes, comandos, hooks, `CLAUDE.md`, settings, plugins e MCPs do Claude Code iguais entre vários computadores.

Cada PC roda o [cliente](https://github.com/le0nardomartins/ClaudeMemorySync) e conversa com este server. O server recebe o que cada PC mudou, **mescla** com a versão anterior sem apagar nada e entrega a versão combinada aos outros PCs.

- **Stack:** Node 22, Express 5 e Postgres, empacotado em Docker e pronto para a [Railway](https://railway.com).
- **Barato:** só circula o que mudou, cada conteúdo é guardado uma vez só (pelo sha256), ficam só as 3 últimas versões e o serviço dorme entre as rodadas.
- **Fechado:** toda rota exige uma assinatura Ed25519 de um PC autorizado. Não há senha compartilhada.

> [!WARNING]
> O banco guarda a configuração do Claude dos seus PCs, **incluindo chaves de API** dos MCPs e do `settings.json`. Rode o seu próprio server, não exponha o Postgres à internet e não compartilhe o acesso ao projeto da Railway.

---

## Sumário

- [Como funciona](#como-funciona)
- [Deploy na Railway](#deploy-na-railway)
- [Autorizar PCs](#autorizar-pcs)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [API](#api)
- [Banco de dados](#banco-de-dados)
- [Merge](#merge)
- [Segurança](#segurança)
- [Custos](#custos)
- [Logs](#logs)
- [Rodar localmente e testes](#rodar-localmente-e-testes)
- [Estrutura](#estrutura)
- [Documentação completa e skill para o Claude](#documentação-completa-e-skill-para-o-claude)

---

## Como funciona

```
 PC A                              SERVER                              PC B
 ────                              ──────                              ────
 POST /upload  ───────────────►  confere assinatura e hashes
 manifesto + só o conteúdo        mescla com a última versão
 que o server não tem             salva a versão N+1 (manifesto)
                                  guarda conteúdo novo em `blobs`
                                  apaga versões além das 3 últimas
                                                       ◄──────────  GET /latest?since=N
                                  manifesto da versão N+1  ───────►
                                                       ◄──────────  POST /blobs {hashes}
                                  só o conteúdo que falta  ───────►
```

- **Manifesto:** lista `caminho → { sha256, size, mtime }` de todos os arquivos de uma versão.
- **Blob:** um conteúdo, identificado pelo sha256 e guardado compactado (deflate-raw). Arquivos iguais em caminhos ou versões diferentes ocupam um blob só.
- **Bundle:** o formato binário trocado com os PCs, uma sequência de registros `[tamanho do nome][nome][tamanho dos dados][dados]`. Os dados ficam compactados de ponta a ponta: o server repassa os bytes do banco sem descompactar.

Detalhes do protocolo em [docs/api.md](docs/api.md).

## Deploy na Railway

**1. Crie o projeto.** Na Railway: **New Project → Deploy from GitHub repo** e escolha este repositório (ou um fork dele). O `railway.json` faz a Railway construir pelo `Dockerfile`.

**2. Adicione um Postgres** no mesmo projeto: **New → Database → PostgreSQL**. Não gere domínio público para ele, porque o server conecta pela rede interna.

**3. Configure as variáveis** do serviço do server (não do Postgres):

| Variável | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referência: a Railway preenche e atualiza sozinha) |
| `CLIENT_PUBLIC_KEYS` | Chaves públicas dos PCs. Veja [Autorizar PCs](#autorizar-pcs). |

**4. Gere o domínio público** em **Settings → Networking → Generate Domain**. Essa URL é a `SERVER_URL` do `.env` de cada PC.

**5. Confira os logs do deploy.** Deve aparecer:

```
memory server na porta 8080 | PCs autorizados: pc-notebook-x7k2
```

As tabelas são criadas sozinhas no primeiro start. Bancos de versões antigas do server (um zip por versão) também são convertidos sozinhos.

Para outro provedor (Fly.io, Render, VPS), use o `Dockerfile` com um Postgres e as mesmas variáveis. Veja [docs/deploy.md](docs/deploy.md).

## Autorizar PCs

Cada PC tem um par de chaves Ed25519. A **privada** fica só no `.env` daquele PC. A **pública** vai para o server.

Gere no próprio PC, pelo cliente:

```powershell
python src\components\remote_client.py keygen pc-notebook-x7k2
```

Ou por este repositório:

```bash
npm run keygen -- pc-notebook-x7k2
```

Copie a linha `pc-notebook-x7k2:<base64>` para `CLIENT_PUBLIC_KEYS`. Com vários PCs, separe por vírgula:

```
CLIENT_PUBLIC_KEYS=pc-notebook-x7k2:AAAA...,pc-desktop-a8f3:BBBB...
```

Para **revogar** um PC, apague a linha dele. A Railway reinicia o server ao salvar a variável.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `DATABASE_URL` | sim* | — | Conexão com o Postgres. *Ou `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` e `PGDATABASE`. |
| `CLIENT_PUBLIC_KEYS` | sim | — | `nome:base64,nome:base64`. O server não sobe se estiver vazia. |
| `MAX_UPLOAD_MB` | não | `50` | Tamanho máximo do corpo de `/upload` e `/blobs`. |
| `DATABASE_SSL` | não | `false` | `true` só se conectar pela URL pública do Postgres. |
| `PORT` | não | `3000` | A Railway define sozinha. |

Modelo comentado em [`.env.example`](.env.example).

## API

Todas as rotas exigem os cabeçalhos `X-Client-Id`, `X-Timestamp` e `X-Signature`. Sem eles, ou com uma assinatura inválida, a resposta é `401`. Isso vale até para rotas que não existem.

| Rota | Corpo | Resposta |
|---|---|---|
| `POST /upload` | Bundle (`application/octet-stream`): `manifest.json` + conteúdos que o server não tem | `201 { versionId, fileCount, totalBytes, newBytes, unchanged }`, `409 { missing: [sha256...] }` se faltar conteúdo, `415` se for o formato zip antigo |
| `GET /latest?since=N` | — | `204` se a versão mais nova é `N`. Senão, bundle com o manifesto e `X-Version-Id`. |
| `POST /blobs` | JSON `{ "hashes": [sha256...] }` (até 5000) | Bundle com os conteúdos encontrados. |
| `GET /versions` | — | JSON com o histórico (id, PC, data, arquivos, bytes) e o total guardado em blobs. |

Formato do bundle, regras de assinatura e exemplos: [docs/api.md](docs/api.md).

## Banco de dados

| Tabela | Linha | Colunas principais |
|---|---|---|
| `blobs` | Um conteúdo único | `sha256` (PK), `size`, `data` (deflate-raw, `STORAGE EXTERNAL`) |
| `memory_versions` | Uma versão | `id`, `client_id`, `created_at`, `file_count`, `total_bytes`, `manifest` (JSON compactado) |

- Ficam só as **3 versões mais novas**. Depois de cada upload, os blobs que nenhuma delas usa são apagados.
- Um upload sem mudança real de conteúdo **não cria versão**, então os outros PCs não têm nada a baixar.
- Dois uploads ao mesmo tempo são serializados por `LOCK TABLE`, e nenhum perde as mudanças do outro.

Manutenção (zerar histórico, backup, tamanho): [docs/operations.md](docs/operations.md).

## Merge

O merge é **complementar**. A mesma regra roda no cliente (`merge_sharing.py`).

| Situação | Resultado |
|---|---|
| Arquivo só em um lado | É mantido. |
| Mesmo conteúdo | Fica como está, com a data mais nova. |
| Texto diferente | Diff por linhas: o que só existe de um lado entra. O mesmo trecho alterado nos dois lados fica com o arquivo de `mtime` maior. |
| JSON diferente | Chaves somam, listas somam sem duplicar, valor divergente → o mais novo. |
| Binário diferente | O mais novo inteiro. |

O server só lê o conteúdo dos arquivos que mudaram **nos dois lados**. O resto é decidido só pelo manifesto.

Como nada é apagado, **remover** um arquivo de vez exige apagar nos PCs e zerar o histórico ([docs/operations.md](docs/operations.md#remover-um-arquivo-de-vez)).

## Segurança

Defesas em ordem, da mais barata para a mais cara. Quem falha numa etapa não chega à seguinte:

1. **Bloqueio por IP:** 10 falhas de autenticação em 15 min → `429` até a janela acabar.
2. **Cabeçalhos:** cliente desconhecido, horário fora de ±5 min ou assinatura mal formada → `401`, sem ler o corpo.
3. **Tamanho:** `POST /upload` e `/blobs` exigem `Content-Length` (sem *chunked*). Acima de `MAX_UPLOAD_MB` → `413`. As outras rotas não aceitam corpo.
4. **Concorrência:** no máximo 2 requisições pesadas ao mesmo tempo (`503` acima disso). A memória fica limitada a ~2 × `MAX_UPLOAD_MB`.
5. **Assinatura Ed25519:** cobre `MÉTODO\nCAMINHO\nTIMESTAMP\nSHA256(corpo)`. Assinatura reenviada é recusada (anti-replay).
6. **Bundle:** recusa caminho `../`, registro repetido, conteúdo fora do manifesto, hash que não confere e zip bomb (descompactação com teto, 200 MB no total).

Além disso:
- Rota inexistente responde `401`, então não dá para descobrir quais rotas existem.
- Cabeçalhos de segurança, sem `X-Powered-By` e sem ETag.
- Timeouts contra conexões lentas (slowloris) e `statement_timeout` no Postgres.
- Toda estrutura em memória tem teto e limpeza periódica, e o heap é limitado a 384 MB.
- O container roda sem root e sem npm, e as dependências têm versão exata.

## Custos

Escolhas que mantêm o server no plano mais barato:

| Escolha | Efeito |
|---|---|
| Delta | Um upload com uma linha mudada pesa ~35 KB (praticamente só o manifesto), contra ~14 MB com o zip completo. |
| Deduplicação por sha256 | Arquivos repetidos e versões parecidas não ocupam espaço extra. |
| 3 versões + limpeza de blobs | O banco fica com algo próximo do tamanho de uma versão compactada. |
| `sleepApplication: true` | Sem tráfego por ~10 min, o serviço dorme e não cobra CPU/RAM. Os clientes rodam a cada 15 min. |
| `node_modules` e `skills/synced` excluídos | Dependências reinstaláveis não ocupam banco nem rede. |

O primeiro pedido depois de o serviço dormir demora alguns segundos a mais. O cliente espera até 120 s.

## Logs

```
memory server na porta 8080 | PCs autorizados: pc-notebook-x7k2, pc-desktop-a8f3
[pc-notebook-x7k2] 177.x.x.x POST /upload -> 201 | recebido 37.5 KB | enviado 0.1 KB | 25 ms | versão 19 salva: 580 arquivos (15.95 MB), 4.8 KB de conteúdo novo guardado
[pc-desktop-a8f3] 189.x.x.x GET /latest -> 200 | recebido 0.0 KB | enviado 30.0 KB | 2 ms | enviou o manifesto da versão 19
[pc-desktop-a8f3] 189.x.x.x POST /blobs -> 200 | recebido 0.1 KB | enviado 4.9 KB | 1 ms | 1 de 1 conteúdo(s) pedidos
[pc-desktop-a8f3] 189.x.x.x GET /latest -> 204 | ... | PC já está na versão mais nova
[recusado] 45.x.x.x (se apresentou como "pc-casa") GET /latest: cabeçalhos de autenticação inválidos
[bloqueado] 45.x.x.x após 10 falhas, por 15 min
```

Tentativas recusadas só geram log na 1ª vez e no bloqueio, para um ataque não lotar os logs.

Não existe rota pública de healthcheck, porque toda rota exige assinatura. Deixe o healthcheck da Railway desligado: o `restartPolicyType: ON_FAILURE` já reinicia o server se ele cair.

## Rodar localmente e testes

```bash
npm ci
npm test                                   # merge, bundle, upload, auth

# server local com um Postgres de teste
docker run -d --name mem-pg -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres \
CLIENT_PUBLIC_KEYS="pc-teste:<base64>" PORT=3999 npm start
```

No cliente, use `SERVER_URL=http://127.0.0.1:3999`. HTTP sem TLS só é aceito para localhost.

## Estrutura

```
src/
  server.js      rotas, ordem das defesas, shutdown
  auth.js        chaves públicas, verificação Ed25519, anti-replay
  security.js    bloqueio por IP, pré-checagem, concorrência, cabeçalhos, log de acesso
  bundle.js      formato bundle, manifesto, exclusões, leitura do upload
  versions.js    merge de manifestos (só lê o conteúdo de quem mudou dos dois lados)
  merge.js       merge de texto / JSON / binário
  db.js          tabelas, migração, salvar versão, limpeza, consultas
  zip.js         leitor do formato antigo (só para a migração)
scripts/keygen.js
test/core.test.js
docs/            documentação completa (também é uma skill do Claude)
Dockerfile · railway.json · .env.example
```

## Documentação completa e skill para o Claude

A pasta [`docs/`](docs/) tem a documentação detalhada e também é uma **skill do Claude Code** (`claude-memory-server`). Com ela, o Claude sabe fazer o deploy, autorizar PCs, consultar o banco e diagnosticar o server.

```powershell
git clone --depth 1 https://github.com/le0nardomartins/ClaudeMemorySync-Server.git $env:TEMP\cms-server
Copy-Item -Recurse $env:TEMP\cms-server\docs $HOME\.claude\skills\claude-memory-server
```

| Documento | Conteúdo |
|---|---|
| [docs/deploy.md](docs/deploy.md) | Railway passo a passo, outros provedores, atualização |
| [docs/api.md](docs/api.md) | Assinatura, formato bundle, rotas e exemplos |
| [docs/operations.md](docs/operations.md) | Banco, backup, zerar histórico, revogar PCs, diagnóstico |
| [docs/SKILL.md](docs/SKILL.md) | Instruções que o Claude segue quando usa a skill |
