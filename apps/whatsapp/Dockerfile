# Build a partir da raiz do repositório (context: . no docker-compose.yml).

# --- build: compila TypeScript e remove devDependencies ---
FROM node:22-slim AS build
WORKDIR /app
COPY apps/whatsapp/package.json apps/whatsapp/package-lock.json ./
RUN npm ci
COPY apps/whatsapp/tsconfig.json ./
COPY apps/whatsapp/src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime: só dist + dependências de produção ---
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# As pastas já existem com dono "node" antes de o volume ser montado; assim o
# volume nomeado é criado com essa permissão e o usuário não-root consegue gravar.
RUN mkdir -p /app/auth /app/queue /app/settings /app/db /app/media \
	&& chown node:node /app/auth /app/queue /app/settings /app/db /app/media
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# Interface admin (destino do encaminhamento)
EXPOSE 3200
CMD ["node", "dist/index.js"]
