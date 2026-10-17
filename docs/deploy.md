# Deploy

- [Railway](#railway)
- [Outros provedores](#outros-provedores)
- [Atualizar](#atualizar)
- [Migrações](#migrações)

## Railway

### 1. Projeto e serviço

1. Faça um fork deste repositório (ou use o original).
2. Na Railway, escolha **New Project → Deploy from GitHub repo** e selecione o repositório.
3. A Railway lê o `railway.json`:
   - constrói pelo `Dockerfile`;
   - mantém 1 réplica;
   - reinicia se o server cair (`ON_FAILURE`, até 10 vezes);
   - **dorme sem tráfego** (`sleepApplication: true`).

O primeiro deploy falha até as variáveis existirem. Isso é esperado.

### 2. Postgres

**New → Database → PostgreSQL** no mesmo projeto. Não gere domínio público para o banco: o server usa a rede interna (`postgres.railway.internal`), sem SSL e sem exposição.

### 3. Variáveis do serviço do server

Em **Variables** do serviço do server (não do Postgres):

```ini
DATABASE_URL=${{Postgres.DATABASE_URL}}
CLIENT_PUBLIC_KEYS=pc-notebook-x7k2:AAAA...,pc-desktop-a8f3:BBBB...
```

- `${{Postgres.DATABASE_URL}}` é uma **referência**: a Railway preenche e atualiza sozinha se a senha mudar.
- As chaves públicas são geradas em cada PC (veja o README, seção "Autorizar PCs").
- Opcionais: `MAX_UPLOAD_MB` (padrão 50) e `DATABASE_SSL=true` (só se usar a URL pública do banco).

### 4. Domínio

Em **Settings → Networking → Generate Domain** você obtém uma URL como `https://seu-app.up.railway.app`. Ela vai em `SERVER_URL` no `.env` de cada PC.

### 5. Conferência

Nos logs do deploy:

```
memory server na porta 8080 | PCs autorizados: pc-notebook-x7k2, pc-desktop-a8f3
```

Em seguida, rode `python src/main.py` em um PC. O log do server deve mostrar `POST /upload -> 201`.

### Healthcheck

Deixe o healthcheck da Railway **desligado**. Toda rota exige assinatura, então um healthcheck HTTP receberia `401`. Além disso, ele manteria o serviço acordado e anularia o sleep. O `restartPolicyType` já cobre quedas.

## Outros provedores

Qualquer lugar que rode um container e tenha Postgres 13+ serve.

```bash
docker build -t claude-memory-server .
docker run -d -p 8080:8080 \
  -e PORT=8080 \
  -e DATABASE_URL=postgres://usuario:senha@host:5432/banco \
  -e CLIENT_PUBLIC_KEYS="pc-a:AAAA...,pc-b:BBBB..." \
  claude-memory-server
```

Requisitos:
- **HTTPS na frente.** O cliente recusa `http://`, exceto `localhost`. Use o TLS do provedor ou um proxy reverso (Caddy, nginx).
- **Um proxy só** entre a internet e o server. O server usa `trust proxy = 1` para obter o IP real usado no bloqueio. Com mais camadas, ajuste esse valor em `server.js`.
- **Memória:** 512 MB bastam (heap limitado a 384 MB).

## Atualizar

1. Faça push na branch configurada. A Railway reconstrói e faz o deploy, e o server novo só recebe tráfego depois de subir.
2. Se a mudança alterou o protocolo, atualize o cliente em **todos** os PCs: `git pull` + `restart_sync.bat`. Até lá, os PCs desatualizados recebem `415` ou `manifesto inválido` e não sincronizam, mas nada é corrompido.

## Migrações

`db.migrate()` roda a cada start e é idempotente:

1. Cria `blobs` e `memory_versions` se não existirem.
2. Se encontra a coluna antiga `package` (um zip inteiro por versão):
   - converte as versões mantidas para manifesto + blobs, já descartando `node_modules` e `skills/synced`;
   - apaga a coluna;
   - roda `VACUUM FULL` para devolver o espaço ao disco.
3. Apaga versões sem manifesto e blobs que nenhuma versão usa.

A conversão do formato antigo é **irreversível**. Para guardar o estado anterior, faça um `pg_dump` antes do deploy (veja [operations.md](operations.md#backup)).
