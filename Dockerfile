FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=3500
ENV HOST=0.0.0.0
# DATABASE_URL (postgres://...) must be provided at deploy time (KB-PG-2).

USER node

EXPOSE 3500

CMD ["node", "src/server.js"]
