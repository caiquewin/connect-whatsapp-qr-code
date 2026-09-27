# Build a partir da raiz do repositório (context: . no docker-compose.yml).

# --- build: compila TypeScript e remove devDependencies ---
FROM node:22-slim AS build
WORKDIR /app
COPY apps/endpoint/package.json apps/endpoint/package-lock.json ./
RUN npm ci
COPY apps/endpoint/tsconfig.json ./
COPY apps/endpoint/src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime: só dist + dependências de produção ---
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
