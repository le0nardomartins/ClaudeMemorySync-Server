---
name: claude-memory-server
description: Faz deploy, opera e diagnostica o server do Claude Memory Sync (Node + Postgres na Railway), que guarda e mescla a configuração do Claude Code de vários PCs. Use quando o usuário pedir para subir ou atualizar o server do memory sync, autorizar ou revogar um PC (CLIENT_PUBLIC_KEYS), ver o tamanho ou o histórico do banco, zerar o histórico, remover um arquivo de vez, ou investigar erros 401/409/413/415/429/503 vistos pelos clientes.
---

# Claude Memory Sync: server

Repositórios:
- **Server** (este): https://github.com/le0nardomartins/backend-memory-interconnection-claude
- **Cliente** (um por PC): https://github.com/le0nardomartins/memory-interconnection-claude (ele tem a skill `claude-memory-sync`)

Leia sob demanda, nesta pasta:
- `deploy.md`: subir na Railway ou em outro provedor, atualizar
- `api.md`: protocolo, para depurar requisições
- `operations.md`: SQL de consulta e manutenção, backup, revogação, diagnóstico

## Regras que valem sempre

1. **Dados sensíveis.** O banco contém chaves de API dos MCPs e do `settings.json` do usuário. Nunca mostre conteúdo de blobs ou manifestos no chat sem o usuário pedir, nunca exponha o Postgres publicamente e nunca compartilhe `DATABASE_URL`.
2. **Chaves.** `CLIENT_PUBLIC_KEYS` só tem chaves públicas, que podem aparecer. Chave **privada** (`CLIENT_PRIVATE_KEY`) nunca vai para o server nem para o chat.
3. **Confirme antes** de deploy, push, mudança de variável na Railway, `TRUNCATE`, `DELETE` ou qualquer outra ação irreversível. Faça backup (`pg_dump`, veja `operations.md`) antes de mexer em dados.
4. **Protocolo casado.** Cliente e server precisam estar na mesma versão do protocolo. Ao atualizar um, lembre o usuário de atualizar o outro em todos os PCs (`git pull` + `restart_sync.bat`).
5. **Nada se apaga pelo merge.** O server mantém todo arquivo que já recebeu. Remover algo de vez exige o procedimento de `operations.md` → "Remover um arquivo de vez".

## Tarefas

### Deploy inicial
Siga `deploy.md` → "Railway". O usuário precisa:
- criar o projeto e o Postgres no painel, ou autorizar o uso da Railway CLI;
- colar as chaves públicas.

No fim, confira no log do deploy a linha `memory server na porta ... | PCs autorizados: ...`.

### Autorizar um PC
1. No PC, gere as chaves: `python src/components/remote_client.py keygen <nome>` (cliente) ou `npm run keygen -- <nome>` (aqui).
2. Acrescente `<nome>:<base64>` em `CLIENT_PUBLIC_KEYS`, separado por vírgula, sem apagar os outros.
3. A Railway reinicia sozinha. Confira o nome em `PCs autorizados` no log.

### Revogar um PC
Apague a entrada dele de `CLIENT_PUBLIC_KEYS`. Os dados que ele já enviou continuam no banco.

### Diagnosticar
Leia os logs do serviço (painel da Railway ou `railway logs`) e compare com `operations.md` → "Diagnóstico". Do lado do cliente, o arquivo é `sync.log`.

### Consultar ou manter o banco
Use as consultas de `operations.md`. Para acesso pontual, use `railway connect Postgres` ou a URL pública temporária. Prefira consultas só de leitura e confirme qualquer escrita.

### Atualizar o server
1. Faça push no repositório: a Railway faz o deploy pelo `Dockerfile`. Migrações rodam sozinhas no start (`db.migrate`).
2. Depois, peça para atualizar os clientes.
