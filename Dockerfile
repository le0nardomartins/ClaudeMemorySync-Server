# Imagem de produção do memory server.
# - dependências instaladas pelo package-lock (versões exatas, sem dev)
# - roda como usuário sem privilégios
# - sem npm/yarn na imagem final (menos superfície de ataque)

FROM node:22.14.0-alpine3.21 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.14.0-alpine3.21
ENV NODE_ENV=production
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
# Teto de heap: um vazamento vira restart controlado em vez de travar a máquina
CMD ["node", "--max-old-space-size=384", "src/server.js"]
