# LedgerLite — production image
FROM node:22-slim AS base
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for node:22; python/make only needed
# as a fallback if a prebuild is unavailable for the platform.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY shared ./shared
COPY server ./server
COPY client ./client

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# /data holds the SQLite DB and local uploads — mount a volume here.
VOLUME ["/data"]
EXPOSE 3000

# VAULT_KEY must be provided at runtime (docker run -e VAULT_KEY=...).
CMD ["npx", "tsx", "server/index.ts"]
