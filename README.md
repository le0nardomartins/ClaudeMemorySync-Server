# Claude Memory Sync - Server

**Português** · [English](README.en.md)

Server do **Claude Memory Sync**, que mantém skills, agentes, comandos, hooks, `CLAUDE.md`, settings, plugins e MCPs do Claude Code iguais entre vários computadores.

Cada PC roda o [cliente](https://github.com/le0nardomartins/ClaudeMemorySync). O cliente faz o merge de 3 vias e **cifra tudo antes de enviar**. Este server é só um **armazém de versões**:
- guarda manifestos e blobs selados, sem conseguir lê-los (nem o nome dos arquivos);
- aceita uma versão nova só se ela partiu da versão mais recente, o que garante que nenhum PC atropele outro.

- **Stack:** Node 22, Express 5 e Postgres, empacotado em Docker e pronto para a [Railway](https://railway.com). Só duas dependências: `express` e `pg`.
- **Barato:** só circula o que mudou, cada conteúdo é guardado uma vez, ficam só as 3 últimas versões, não há merge nem descompactação no server e o serviço dorme entre as rodadas.
- **Fechado:** toda rota exige uma assinatura Ed25519 de um PC autorizado, e um vazamento do banco só expõe dados cifrados.

> Não quer manter um server? O cliente também sincroniza por um **repositório Git privado**, sem deploy nenhum. Veja o [modo Git](https://github.com/le0nardomartins/ClaudeMemorySync/blob/main/docs/git-backend.md). Este server continua sendo o modo padrão.

---

## Sumário

- [Como funciona](#como-funciona)
- [Deploy na Railway](#deploy-na-railway)
- [Autorizar PCs](#autorizar-pcs)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [API](#api)
- [Banco de dados](#banco-de-dados)
- [Segurança](#segurança)
- [Custos](#custos)
- [Logs](#logs)
- [Rodar localmente e testes](#rodar-localmente-e-testes)
- [Estrutura](#estrutura)
- [Documentação completa e skill para o Claude](#documentação-completa-e-skill-para-o-claude)

---

## Como funciona

```
 PC A                                 SERVER                                PC B
 ────                                 ──────                                ────
 GET /latest  ◄──────────────  manifesto selado da versão N
 (merge de 3 vias no PC, cifra o resultado)
 POST /upload ──────────────►  base == N (a mais nova)?
 base=N, version=N+1             sim → guarda versão N+1 + blobs novos
 refs + blobs novos              não → 409 conflict: o PC busca e refaz o merge
                                 apaga versões além das 3 últimas e blobs órfãos
                                                    ◄──────────────  GET /latest?since=N
                               manifesto selado da N+1  ───────────►
                                                    ◄──────────────  POST /blobs {ids}
                               só os blobs que faltam   ───────────►
```

- **Manifesto selado:** a lista de arquivos da versão, cifrada pelo PC. O server guarda e devolve os bytes sem abrir.
- **Blob:** um conteúdo cifrado, identificado por um id de 64 hex calculado no PC (HMAC-SHA256 com a `SYNC_KEY`). O mesmo conteúdo em vários caminhos ou versões ocupa um blob só.
- **refs:** a lista de ids que uma versão usa. É a única coisa que o server entende, e serve para checar que nada falta e para apagar blobs que nenhuma versão usa.
- **Versão:** número sequencial. Impede que um PC envie em cima de uma versão que ele não viu. Quem ganha um conflito é decidido nos PCs, pela data de modificação dos arquivos (que vai cifrada no manifesto).

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

As tabelas são criadas sozinhas no primeiro start. Para outro provedor (Fly.io, Render, VPS), veja [docs/deploy.md](docs/deploy.md).

## Autorizar PCs

Cada PC tem um par de chaves Ed25519. A **privada** fica só no `.env` daquele PC. A **pública** vai para o server.

Gere no próprio PC, pelo cliente:

```bash
python src/components/remote_client.py keygen pc-notebook-x7k2
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

A `SYNC_KEY` (criptografia) **não** passa pelo server: ela existe só nos `.env` dos PCs.

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
| `GET /latest?since=N` | — | `204` se a mais nova é `N` (ou não há nenhuma). Senão, bundle com o manifesto selado. `X-Version-Id` sempre presente. |
| `POST /blobs` | JSON `{ "ids": [...] }` (até 20000) | Bundle com os blobs encontrados. |
| `POST /upload` | Bundle: `meta.json` `{ base, version, refs }` + manifesto selado + blobs novos | `201 { versionId, refCount, newBytes, prunedBlobs }`, `409 { conflict: true, latest }` se outro PC chegou antes, `409 { missing: [...] }` se faltar blob, `415` para cliente antigo |
| `GET /versions` | — | Histórico (id, PC, data, nº de refs) e o total guardado em blobs. |

Formato do bundle, regras de assinatura e exemplos: [docs/api.md](docs/api.md).

## Banco de dados

| Tabela | Linha | Colunas |
|---|---|---|
| `cms_blobs` | Um conteúdo cifrado | `id` (PK), `data` (`STORAGE EXTERNAL`: já vem compactado e cifrado), `created_at` |
| `cms_versions` | Uma versão | `id`, `client_id`, `created_at`, `manifest` (selado), `refs` (`TEXT[]`) |

- Ficam só as **3 versões mais novas**. A cada upload, os blobs que nenhuma delas usa são apagados.
- Uploads simultâneos são serializados por `LOCK TABLE`. Só o que partiu da versão mais nova é aceito, e o outro recebe `409 conflict` e refaz o merge no PC.
- Na primeira subida depois de atualizar do protocolo antigo (merge no server), as tabelas antigas (`memory_versions`, `blobs`) são **apagadas**. Os PCs guardam a base localmente e reenviam tudo, cifrado, na rodada seguinte.

Manutenção (zerar, backup, tamanho): [docs/operations.md](docs/operations.md).

## Segurança

Defesas em ordem, da mais barata para a mais cara. Quem falha numa etapa não chega à seguinte:

1. **Bloqueio por IP:** 10 falhas de autenticação em 15 min → `429` até a janela acabar.
2. **Cabeçalhos:** cliente desconhecido, horário fora de ±5 min ou assinatura mal formada → `401`, sem ler o corpo.
3. **Tamanho:** `POST /upload` e `/blobs` exigem `Content-Length` (sem *chunked*). Acima de `MAX_UPLOAD_MB` → `413`. As outras rotas não aceitam corpo.
4. **Concorrência:** no máximo 2 requisições pesadas ao mesmo tempo (`503` acima disso).
5. **Assinatura Ed25519:** cobre `MÉTODO\nCAMINHO\nTIMESTAMP\nSHA256(corpo)`. Uma assinatura reenviada é recusada.
6. **Bundle:** recusa registros repetidos, ids fora do formato, blobs fora das `refs`, versão fora de sequência e formato antigo.

Além disso:
- **Sem conteúdo legível no banco.** Com `SYNC_KEY` nos PCs, o server só vê bytes cifrados, ids opacos e tamanhos.
- Rota inexistente responde `401`, então não dá para descobrir quais rotas existem.
- Cabeçalhos de segurança, sem `X-Powered-By` e sem ETag.
- Timeouts contra conexões lentas (slowloris) e `statement_timeout` no Postgres.
- Toda estrutura em memória tem teto, e o heap é limitado a 384 MB.
- O container roda sem root e sem npm, e as dependências têm versão exata.

## Custos

| Escolha | Efeito |
|---|---|
| Envio só do que mudou | Uma linha alterada numa skill vira um upload de poucos KB. |
| Deduplicação por id | Conteúdo repetido, em vários caminhos ou versões, ocupa um blob só. |
| 3 versões + limpeza de blobs | O banco fica perto do tamanho de uma versão compactada. |
| Nada de merge nem descompactação no server | CPU e RAM mínimas por requisição. |
| `sleepApplication: true` | Sem tráfego por ~10 min, o serviço dorme e não cobra CPU/RAM. Os clientes rodam a cada 15 min. |
| `node_modules` e `skills/synced` excluídos no cliente | Dependências reinstaláveis não ocupam banco nem rede. |

O primeiro pedido depois de o serviço dormir demora alguns segundos a mais. O cliente espera até 120 s.

## Logs

```
memory server na porta 8080 | PCs autorizados: pc-notebook-x7k2, pc-desktop-a8f3
[pc-notebook-x7k2] 177.x.x.x GET /latest -> 204 | ... | PC já está na versão mais nova
[pc-notebook-x7k2] 177.x.x.x POST /upload -> 201 | recebido 4.1 KB | ... | versão 19 salva: 580 blobs referenciados, 0.1 KB novos, 1 antigos apagados
[pc-desktop-a8f3] 189.x.x.x GET /latest -> 200 | ... | enviou o manifesto da versão 19
[pc-desktop-a8f3] 189.x.x.x POST /blobs -> 200 | ... | 1 de 1 blob(s) pedidos
[pc-desktop-a8f3] 189.x.x.x POST /upload -> 409 | ...                (outro PC chegou antes; o cliente refaz o merge)
[recusado] 45.x.x.x (se apresentou como "pc-casa") GET /latest: cabeçalhos de autenticação inválidos
[bloqueado] 45.x.x.x após 10 falhas, por 15 min
```

Tentativas recusadas só geram log na 1ª vez e no bloqueio, para um ataque não lotar os logs.

Não há rota de healthcheck pública, porque toda rota exige assinatura. Deixe o healthcheck da Railway desligado: o `restartPolicyType: ON_FAILURE` já reinicia o server se ele cair.

## Rodar localmente e testes

```bash
npm ci
npm test                                   # bundle, upload, auth

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
  bundle.js      formato bundle e leitura do upload (meta, manifesto, blobs)
  db.js          tabelas, migração, versão com controle de concorrência, limpeza, consultas
scripts/keygen.js
test/core.test.js
docs/            documentação completa (também é uma skill do Claude)
docs/en/         a mesma documentação em inglês (também é skill)
Dockerfile · railway.json · .env.example
```

## Documentação completa e skill para o Claude

A pasta [`docs/`](docs/) tem a documentação detalhada e também é uma **skill do Claude Code** (`claude-memory-server`). Com ela, o Claude sabe fazer o deploy, autorizar PCs, consultar o banco e diagnosticar o server.

```bash
git clone --depth 1 https://github.com/le0nardomartins/ClaudeMemorySync-Server.git /tmp/cms-server
cp -r /tmp/cms-server/docs ~/.claude/skills/claude-memory-server     # Windows: Copy-Item -Recurse
```

| Documento | Conteúdo |
|---|---|
| [docs/deploy.md](docs/deploy.md) | Railway passo a passo, outros provedores, atualização |
| [docs/api.md](docs/api.md) | Assinatura, formato bundle, rotas e exemplos |
| [docs/operations.md](docs/operations.md) | Banco, backup, zerar histórico, revogar PCs, diagnóstico |
| [docs/SKILL.md](docs/SKILL.md) | Instruções que o Claude segue quando usa a skill |

Documentação em inglês: [docs/en/](docs/en/), que também funciona como skill.

## Licença

[MIT](LICENSE).
