# Operação

- [Acessar o banco](#acessar-o-banco)
- [Consultas úteis](#consultas-úteis)
- [Backup](#backup)
- [Zerar o histórico](#zerar-o-histórico)
- [Autorizar e revogar PCs](#autorizar-e-revogar-pcs)
- [Diagnóstico](#diagnóstico)

> Com `SYNC_KEY` nos PCs, o banco só tem dados cifrados. Sem ela, contém as chaves de API dos PCs: nesse caso, trate dumps com o mesmo cuidado que um `.env`.

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
SELECT id, client_id, created_at, cardinality(refs) AS arquivos,
       pg_size_pretty(length(manifest)::bigint) AS manifesto
  FROM cms_versions ORDER BY id DESC;

-- Espaço ocupado
SELECT pg_size_pretty(pg_total_relation_size('cms_blobs'))    AS blobs,
       pg_size_pretty(pg_total_relation_size('cms_versions')) AS versoes,
       (SELECT count(*) FROM cms_blobs)                        AS n_blobs;

-- Maiores blobs
SELECT id, pg_size_pretty(length(data)::bigint) AS tamanho, created_at
  FROM cms_blobs ORDER BY length(data) DESC LIMIT 20;

-- Os dados estão cifrados? (E1 = AES-256-GCM, P1 = só compactado)
SELECT convert_from(substring(data from 1 for 2), 'SQL_ASCII') AS formato, count(*)
  FROM cms_blobs GROUP BY 1;
```

O server não consegue ler caminhos nem conteúdo. Para ver o que está em cada versão, use o cliente num PC.

## Backup

```bash
pg_dump "$DATABASE_PUBLIC_URL" -Fc -f memory-$(date +%Y%m%d).dump
# restaurar
pg_restore -d "$DATABASE_URL_DESTINO" --clean memory-AAAAMMDD.dump
```

O backup só serve com a `SYNC_KEY` dos PCs. Lembre também que cada PC já guarda localmente a versão completa do último sync (`SHARING_MEMORY/`), além de `.sync_trash/` e `.sync_conflicts/`.

## Zerar o histórico

Use quando trocar a `SYNC_KEY`, depois de restaurar um backup errado, ou para recomeçar do zero.

```sql
TRUNCATE cms_versions, cms_blobs;
```

No próximo sync, o primeiro PC a rodar envia tudo de novo (versão 1), e os outros recebem e mesclam com a base local. Nada é perdido nos PCs: zerar o server não apaga arquivos de ninguém.

Para **remover um arquivo** de todos os PCs, não é preciso mexer no server: basta apagá-lo em um PC. A remoção se propaga pelo merge de 3 vias.

## Autorizar e revogar PCs

`CLIENT_PUBLIC_KEYS` é a única lista de acesso.

| Ação | Como |
|---|---|
| Autorizar | Acrescente `nome:base64` (gerado com `keygen` no PC), separado por vírgula. |
| Revogar | Apague a entrada. Se o PC foi comprometido, troque também a `SYNC_KEY` nos outros PCs e zere o histórico. |
| Trocar a chave de um PC | Gere um par novo no PC, troque o `.env` dele e a entrada aqui. |

Ao salvar a variável, a Railway reinicia o server, e a linha `PCs autorizados: ...` no log confirma a lista.

## Diagnóstico

| Log do server | Significado |
|---|---|
| `Falha ao iniciar: CLIENT_PUBLIC_KEYS vazia` | Falta a variável. |
| `Falha ao iniciar: Defina DATABASE_URL ou ...` | Falta a variável do banco. |
| `[migração] tabelas do protocolo antigo removidas` | Primeiro start depois de atualizar do protocolo com merge no server. Normal, uma vez só. Os PCs reenviam tudo. |
| `[recusado] IP (se apresentou como "x") ...` | Requisição sem assinatura válida. Se `x` é um PC seu: chave errada, nome errado ou relógio errado. |
| `[bloqueado] IP após 10 falhas` | IP bloqueado por 15 min. |
| `POST /upload -> 409` seguido de `-> 201` do mesmo PC | Normal: dois PCs sincronizaram juntos, e um refez o merge. |
| `POST /upload -> 400 ... formato antigo` ou `-> 415` | Cliente antigo. Atualize o cliente desse PC. |
| `[pg] conexão ociosa falhou` | Postgres reiniciou. O pool reconecta sozinho. |
| `[erro] ...` com `500` para o cliente | Erro inesperado. Abra uma issue com a linha do log. |

| O cliente vê | Lado do server |
|---|---|
| `não consegui falar com ...` | Serviço fora do ar, domínio errado ou acordando do sleep (o cliente espera até 120 s). |
| `HTTP 503 ocupado` | Já há 2 operações pesadas em andamento. O cliente tenta de novo na próxima rodada. |
| `HTTP 413` | Aumente `MAX_UPLOAD_MB` ou reduza o que é sincronizado. |
| `outro PC enviou antes 5 vezes seguidas` | Muitos PCs enviando ao mesmo tempo. Resolve sozinho na próxima rodada. |
