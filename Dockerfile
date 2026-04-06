FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --omit=dev
EXPOSE 3000
# Rebuild trigger Mon Apr 06 18:00:00 UTC 2026 - tsconfig fix + new files
CMD ["node", "dist/server.js"]