---
name: claude-memory-server
description: Faz deploy, opera e diagnostica o server do Claude Memory Sync (Node + Postgres na Railway), um armazém de versões cifradas com controle de concorrência que guarda a configuração do Claude Code de vários PCs. Use quando o usuário pedir para subir ou atualizar o server do memory sync, autorizar ou revogar um PC (CLIENT_PUBLIC_KEYS), ver o tamanho ou o histórico do banco, zerar o histórico (ex.: ao trocar a SYNC_KEY), ou investigar erros 401/409/413/415/429/503 vistos pelos clientes.
---

# Claude Memory Sync: server

Repositórios:
- **Server** (este): https://github.com/le0nardomartins/ClaudeMemorySync-Server
- **Cliente** (um por PC): https://github.com/le0nardomartins/ClaudeMemorySync. Ele tem a skill `claude-memory-sync`, faz o merge de 3 vias, cifra tudo com a `SYNC_KEY` e também suporta um modo sem server, por repositório Git privado.

O server **não faz merge e não lê o conteúdo**. Ele guarda manifestos e blobs selados e só aceita uma versão nova se ela partiu da mais recente (`409 conflict` caso contrário).

Leia sob demanda, nesta pasta:
- `deploy.md`: subir na Railway ou em outro provedor, atualizar
- `api.md`: protocolo, para depurar requisições
- `operations.md`: SQL de consulta e manutenção, backup, revogação, diagnóstico

## Regras que valem sempre

1. **Dados.** Com `SYNC_KEY` nos PCs, o banco só tem dados cifrados. Sem ela, contém chaves de API do usuário. Em qualquer caso, nunca exponha o Postgres publicamente e nunca compartilhe `DATABASE_URL`.
2. **Chaves.** `CLIENT_PUBLIC_KEYS` só tem chaves públicas, que podem aparecer. `CLIENT_PRIVATE_KEY` e `SYNC_KEY` nunca vão para o server nem para o chat.
3. **Confirme antes** de deploy, push, mudança de variável na Railway, `TRUNCATE`, `DELETE` ou qualquer outra ação irreversível. Faça backup (`pg_dump`, veja `operations.md`) antes de mexer em dados.
4. **Protocolo casado.** Cliente e server precisam estar na mesma versão do protocolo. Ao atualizar um, lembre o usuário de atualizar o outro em todos os PCs.
5. **Zerar o server não apaga nada nos PCs.** Cada PC guarda a base localmente e reenvia tudo na rodada seguinte. Para remover um arquivo de todos os PCs, basta apagar em um PC: não mexa no server para isso.

## Tarefas

### Deploy inicial
Siga `deploy.md` → "Railway". O usuário precisa:
- criar o projeto e o Postgres no painel, ou autorizar o uso da Railway CLI;
- colar as chaves públicas.

No fim, confira no log a linha `memory server na porta ... | PCs autorizados: ...`.

### Autorizar um PC
1. No PC, gere as chaves: `python src/components/remote_client.py keygen <nome>` (cliente) ou `npm run keygen -- <nome>` (aqui).
2. Acrescente `<nome>:<base64>` em `CLIENT_PUBLIC_KEYS`, separado por vírgula, sem apagar os outros.
3. A Railway reinicia sozinha. Confira o nome em `PCs autorizados` no log.

### Revogar um PC
Apague a entrada dele de `CLIENT_PUBLIC_KEYS`. Se a máquina foi comprometida, oriente a troca da `SYNC_KEY` em todos os PCs (troubleshooting do cliente) e zere o histórico (`operations.md`).

### Diagnosticar
Leia os logs do serviço (painel da Railway ou `railway logs`) e compare com `operations.md` → "Diagnóstico". Do lado do cliente, o arquivo é `sync.log`. `409` seguido de `201` é normal.

### Consultar ou manter o banco
Use as consultas de `operations.md`. Para acesso pontual, use `railway connect Postgres`. Prefira consultas só de leitura e confirme qualquer escrita.

### Atualizar o server
1. Faça push no repositório: a Railway faz o deploy pelo `Dockerfile`. Migrações rodam sozinhas no start (`db.migrate`).
2. Depois, peça para atualizar os clientes.
