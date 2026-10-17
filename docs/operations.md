# Operação

- [Acessar o banco](#acessar-o-banco)
- [Consultas úteis](#consultas-úteis)
- [Backup](#backup)
- [Remover um arquivo de vez](#remover-um-arquivo-de-vez)
- [Zerar tudo](#zerar-tudo)
- [Autorizar e revogar PCs](#autorizar-e-revogar-pcs)
- [Diagnóstico](#diagnóstico)

> O banco contém chaves de API dos PCs. Trate dumps e consultas com o mesmo cuidado que um `.env`.

## Acessar o banco

Pela Railway CLI, sem expor o banco:

```bash
railway link            # escolha o projeto
railway connect Postgres
```

Outra opção é ativar temporariamente o **TCP Proxy** do Postgres no painel e usar a `DATABASE_PUBLIC_URL` num cliente local. Desative quando terminar.

## Consultas úteis

```sql
-- Versões guardadas
SELECT id, client_id, created_at, file_count,
       pg_size_pretty(total_bytes) AS conteudo,
       pg_size_pretty(length(manifest)::bigint) AS manifesto
  FROM memory_versions ORDER BY id DESC;

-- Espaço ocupado
SELECT pg_size_pretty(pg_total_relation_size('blobs'))           AS blobs,
       pg_size_pretty(pg_total_relation_size('memory_versions')) AS versoes,
       (SELECT count(*) FROM blobs)                               AS n_blobs;

-- Maiores conteúdos guardados
SELECT sha256, pg_size_pretty(size) AS original, pg_size_pretty(length(data)::bigint) AS compactado
  FROM blobs ORDER BY length(data) DESC LIMIT 20;
```

O manifesto é JSON compactado (deflate-raw), então o SQL não lê os caminhos. Para ver o conteúdo de uma versão, use `GET /versions` ou o cliente.

## Backup

```bash
pg_dump "$DATABASE_PUBLIC_URL" -Fc -f memory-$(date +%Y%m%d).dump
# restaurar
pg_restore -d "$DATABASE_URL_DESTINO" --clean memory-AAAAMMDD.dump
```

O dump contém as chaves de API dos seus PCs: guarde-o como um segredo. Lembre também que o server não é backup: ele guarda só 3 versões.

## Remover um arquivo de vez

O merge nunca apaga: se um arquivo existe na última versão, ele continua em todas as seguintes, e os PCs o recebem de volta. Para removê-lo:

1. **Pare o sync** em todos os PCs (`install_autostart.ps1 -Uninstall`, ou encerre a tarefa `ClaudeMemorySync`).
2. **Apague o arquivo** em `~/.claude/claude_memory_sharing` de **todos** os PCs.
3. **Zere o histórico** do server:
   ```sql
   TRUNCATE memory_versions, blobs;
   ```
4. Em **um** PC, apague `.sync_state.json` e `SHARING_MEMORY/` e rode `python src/main.py`. Ele envia tudo de novo, já sem o arquivo (versão nova).
5. Nos outros PCs, apague `.sync_state.json` e reative o sync. Eles baixam a versão nova, reaproveitando o conteúdo local.

O passo 4 precisa apagar `.sync_state.json`. Sem isso, o PC acha que o server já tem o conteúdo dele e não envia nada.

## Zerar tudo

Mesmo procedimento da seção anterior, sem o passo 2. Use quando quiser recomeçar o histórico, ou depois de restaurar um backup errado.

## Autorizar e revogar PCs

`CLIENT_PUBLIC_KEYS` é a única lista de acesso.

| Ação | Como |
|---|---|
| Autorizar | Acrescente `nome:base64` (gerado com `keygen` no PC), separado por vírgula. |
| Revogar | Apague a entrada. O que o PC já enviou continua no banco. |
| Trocar a chave de um PC | Gere um par novo no PC, troque o `.env` dele e a entrada aqui. |

Ao salvar a variável, a Railway reinicia o server, e a linha `PCs autorizados: ...` no log confirma a lista.

## Diagnóstico

| Log do server | Significado |
|---|---|
| `Falha ao iniciar: CLIENT_PUBLIC_KEYS vazia` | Falta a variável. |
| `Falha ao iniciar: Defina DATABASE_URL ou ...` | Falta a variável do banco. |
| `[migração] N versão(ões) convertidas` | Primeiro start depois de atualizar do formato zip. Normal, uma vez só. |
| `[recusado] IP (se apresentou como "x") ...` | Requisição sem assinatura válida. Se `x` é um PC seu: chave errada, nome errado ou relógio errado. |
| `[bloqueado] IP após 10 falhas` | IP bloqueado por 15 min. |
| `POST /upload -> 409` seguido de `-> 201` | Normal: o cliente mandou o conteúdo que faltava. |
| `POST /upload -> 415` | Cliente antigo (formato zip). Atualize o cliente desse PC. |
| `[pg] conexão ociosa falhou` | Postgres reiniciou. O pool reconecta sozinho. |
| `[erro] ...` com `500` para o cliente | Erro inesperado. Abra uma issue com a linha do log. |

| O cliente vê | Lado do server |
|---|---|
| `não consegui falar com ...` | Serviço fora do ar, domínio errado ou acordando do sleep (o cliente espera até 120 s). |
| `HTTP 503 ocupado` | Já há 2 operações pesadas em andamento. O cliente tenta de novo na próxima rodada. |
| `HTTP 413` | Aumente `MAX_UPLOAD_MB` ou reduza o que é sincronizado. |
