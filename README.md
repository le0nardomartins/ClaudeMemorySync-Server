# Memory server

Server Node que recebe a pasta `NEW_MEMORY` zipada de cada PC, mescla com a versão anterior e guarda as **5 últimas versões** no Postgres da Railway.

## Rotas

Todas exigem assinatura (ver [Autenticação](#autenticação)). Sem ela a resposta é `401`.

| Rota | O que faz |
|------|-----------|
| `POST /upload` | Corpo `application/zip` com `manifest.json`. Valida, mescla com a última versão e salva como versão nova. |
| `GET /latest?since=N` | Zip da versão mais nova, com `X-Version-Id`. `204` se não houver nada mais novo que `N`. |
| `GET /versions` | Lista o histórico (id, PC, data, nº de arquivos). |

## Autenticação

Ed25519, uma chave por PC:

- a **chave privada** fica só no `.env` do PC e nunca trafega;
- a Railway guarda só as **chaves públicas**, que servem para verificar e não para assinar. Vazar as variáveis da Railway não permite se passar por nenhum PC;
- cada requisição assina `MÉTODO\nCAMINHO\nTIMESTAMP\nSHA256(corpo)`. Requisições com mais de 5 minutos, com corpo alterado ou reenviadas são recusadas.

Gerar as chaves de um PC novo:

```
cd backend
npm run keygen -- pc-trabalho
```

As linhas `CLIENT_ID` e `CLIENT_PRIVATE_KEY` vão para o `.env` do projeto naquele PC. A linha `pc-trabalho:<base64>` vai para `CLIENT_PUBLIC_KEYS` na Railway. Separe os PCs com vírgula. Para revogar um PC, apague a linha dele.

## Merge ("complementar")

Ao receber um envio, o server junta os arquivos novos com a última versão salva. A mesma regra vale no PC, em `src/components/merge_sharing.py`:

- **Texto:** linhas que só existem em um lado entram e nada é apagado. Se o mesmo trecho mudou nos dois lados, ganha o arquivo mais novo (mtime).
- **JSON:** chaves novas entram, listas são somadas sem duplicar e, em valor divergente, ganha o mais novo.
- **Binário:** ganha o mais novo inteiro.
- Arquivo que só existe em um lado é mantido.

Consequência: **apagar** um arquivo ou uma linha não se propaga para os outros PCs. Para remover algo de vez, apague em todos os PCs.

## Deploy na Railway

1. Novo serviço a partir do repositório, com **Root Directory** `backend`. O `railway.json` manda a Railway construir pelo `Dockerfile`. Se ela não detectar sozinha, aponte **Settings → Config-as-code** para `/backend/railway.json`.
2. Adicione um **Postgres** no mesmo projeto. Não gere domínio público para ele: o server conecta pela rede interna.
3. Em **Variables** do serviço:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `CLIENT_PUBLIC_KEYS` = `pc-casa:<base64>,pc-trabalho:<base64>`
   - opcionais: `MAX_UPLOAD_MB` (padrão 50) e `DATABASE_SSL=true` se usar a URL pública do Postgres.
4. Gere um domínio público em **Settings → Networking** e coloque a URL em `SERVER_URL` no `.env` de cada PC.

A tabela `memory_versions` é criada sozinha na primeira vez que o server sobe. Cada versão guarda o **pacote zip já pronto** (bytea). O merge e a compactação acontecem uma única vez, no upload, e o `GET /latest` só repassa esses bytes, sem gastar CPU. O PC descompacta e restaura os arquivos.

## Logs

```
memory server na porta 8080 | PCs autorizados: pc-notebook-x7k2, pc-desktop-a8f3
[pc-notebook-x7k2] 177.x.x.x POST /upload -> 201 | recebido 1.01 MB | enviado 0.1 KB | 60 ms | versão 3 salva: 102 arquivos, 1.35 MB -> 1.01 MB compactado
[pc-desktop-a8f3] 189.x.x.x GET /latest -> 200 | recebido 0.0 KB | enviado 1.01 MB | 1 ms | enviou versão 3
[pc-desktop-a8f3] 189.x.x.x GET /latest -> 204 | ... | PC já está na versão mais nova
[recusado] 45.x.x.x (se apresentou como "pc-casa") GET /latest: cabeçalhos de autenticação inválidos
[bloqueado] 45.x.x.x após 10 falhas, por 15 min
```

Tentativas recusadas só geram log na 1ª vez e no bloqueio, para um ataque não lotar os logs.

Não há rota de healthcheck pública, porque toda rota exige assinatura. Deixe o healthcheck da Railway desligado: o `restartPolicyType: ON_FAILURE` já reinicia o server se ele cair.

## Defesas

Em ordem, da mais barata para a mais cara. Quem falha numa etapa não chega à seguinte:

1. **Bloqueio por IP:** 10 falhas de autenticação em 15 minutos → `429` até a janela acabar.
2. **Cabeçalhos:** cliente desconhecido, horário fora de ±5 minutos ou assinatura mal formada → `401`, sem ler o corpo.
3. **Tamanho:** o upload exige `Content-Length` e nada de envio *chunked*. Acima de `MAX_UPLOAD_MB` → `413`. As outras rotas não aceitam corpo.
4. **Concorrência:** no máximo 2 requisições pesadas ao mesmo tempo (`503` acima disso). Assim o uso de memória fica limitado a cerca de 2 × `MAX_UPLOAD_MB`.
5. **Assinatura Ed25519:** cobre método, caminho, horário e hash do corpo. Uma assinatura reenviada é recusada.
6. **Zip:** recusa caminho `../`, nomes repetidos, arquivos fora do manifesto, hash errado e zip bomb (limite de 200 MB descompactados, contando os bytes reais e não o valor declarado no cabeçalho).

Também: rota inexistente responde `401` (não dá para descobrir quais rotas existem), cabeçalhos de segurança, sem `X-Powered-By` e sem ETag, timeouts contra conexões lentas (slowloris), `statement_timeout` no Postgres, todo `Map` em memória com teto e limpeza periódica, heap limitado a 384 MB, container sem root e sem npm, e dependências com versão exata (`npm audit`: 0 vulnerabilidades).

## Testes

```
npm install
npm test
```
