FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=3500
ENV HOST=0.0.0.0
ENV KANBUNNY_DB_PATH=/data/kanbunny.db

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3500

CMD ["node", "src/server.js"]
