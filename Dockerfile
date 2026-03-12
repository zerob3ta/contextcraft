FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Cache bust: 2026-03-12-v2
CMD ["npx", "tsx", "server/index.ts"]
