# syntax=docker/dockerfile:1
# Multi-stage build: smaller production image without dev tools.

# -----------------------------------------------------------------------------
# Stage 1: build (TS -> JS, frontend bundle)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# pg is a pure-JS driver — no native build toolchain needed (better-sqlite3 removed)
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: runtime (production)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Only install runtime deps (drops dev tooling)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# SQL migrations are executed at boot by the app's migration runner
COPY --from=build /app/migrations ./migrations

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

# DATABASE_URL must be provided at runtime (docker-compose sets it automatically)

# Health check uses the READINESS endpoint (verifies DB connectivity).
# Liveness (/api/health/live) is separate and never touches the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||5000)+'/api/health/ready', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
