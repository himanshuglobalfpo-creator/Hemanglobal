# PostgreSQL Migration (v2.0.0)

LedgerLite's data layer has been migrated from SQLite (better-sqlite3) to
**PostgreSQL** (node-postgres + Drizzle ORM) for production scale.

## What changed

### Dependencies
- **Removed:** `better-sqlite3`, `@types/better-sqlite3`, `sql.js`
- **Added:** `pg` (^8.13), `@types/pg`

### Connection (server/storage.ts)
- Single shared `pg.Pool` singleton — **min 2 / max 10** connections
  (tunable via `PG_POOL_MIN` / `PG_POOL_MAX`).
- `server/auth.ts` and `server/auth-routes.ts` no longer open their own
  database connections — they import `{ db, pool }` from `./storage`.
- Global type parsers convert pg's string-typed BIGINT/NUMERIC results to
  JS numbers, so `SUM()`/`COUNT()` in the report queries stay numeric.

### Schema (shared/schema.ts, shared/auth-schema.ts)
- `sqliteTable` → `pgTable` (drizzle-orm/pg-core)
- `integer(...).primaryKey({ autoIncrement: true })` → `serial(...).primaryKey()`
- `integer(..., { mode: "boolean" })` → `boolean(...)`
- `real(...)` → `doublePrecision(...)`
- `text(...).default("CURRENT_TIMESTAMP")` → `timestamp(..., { mode: "string" }).defaultNow()`
  (string mode preserves the app-wide ISO-string date contract)

### Migrations
- The old import-time `initSchema()` / `sqlite.exec()` bootstrap is gone.
- Ordered `.sql` files in `migrations/pg/` run at boot, tracked in a
  `schema_migrations` table so each applies exactly once, each inside its
  own transaction (rollback on failure).
- `migrations/pg/0000_init.sql` contains the full schema end-state,
  including per-org unique constraints — `UNIQUE(org_id, number)` on
  invoices/bills, `UNIQUE(org_id, code)` on accounts — and the quoted
  `"user"` column in audit_log (reserved word in PostgreSQL).

### Async everywhere
- Every `DatabaseStorage` method, auth function, and note-service function
  is now `async` (PostgreSQL client is async-only).
- `sqlite.transaction(() => {...})` → `await db.transaction(async (tx) => {...})`
  with all statements inside using the `tx` handle (true transactional scope).
- Raw `sqlite.prepare(...)` report queries → `pool.query` with `$n`
  placeholders; SQLite-isms translated (`IFNULL`→`COALESCE`,
  `datetime('now')`→`now()`, `IN (?,...)`→`= ANY($1)`, camelCase aliases
  quoted, HAVING aggregates repeated instead of alias references).

### Bootstrap (server/index.ts)
- `await initDatabase()` runs migrations + seeds the default chart of
  accounts BEFORE routes register.
- Graceful shutdown drains the pool (`closeDatabase()`).

### Health check
- `GET /api/health` now runs `SELECT 1`:
  - 200 `{ "db": "ok", "ok": true, "ts": ... }` when connected
  - 503 `{ "db": "error", "message": ... }` when not

### Docker
- `docker-compose.yml` adds a `postgres:16-alpine` service with a health
  check; the app waits for it (`depends_on: condition: service_healthy`)
  and receives `DATABASE_URL` pointing at the service.
- `Dockerfile` drops the python3/make/g++ toolchain (pg is pure JS) and
  copies `migrations/` into the runtime image.

## Configuration

```
DATABASE_URL=postgresql://user:pass@localhost:5432/ledgerlite
PG_POOL_MIN=2      # optional
PG_POOL_MAX=10     # optional
```

## Running

```bash
# Local (needs a PostgreSQL server):
createdb ledgerlite
DATABASE_URL=postgresql://user:pass@localhost:5432/ledgerlite npm run dev

# Docker (postgres included):
docker compose up --build
```

## Verified against a live PostgreSQL 16
- Migration applies once, skipped on second boot (idempotent tracking)
- Signup → org + user + session + 24-account CoA seed
- Invoice create/pay (GL entries posted in pg transactions)
- Credit note CN-0001 issue (sequential numbering + tx + revenue reversal)
- Trial balance / balance sheet / P&L / general ledger / dashboard —
  all balanced (debits = credits), numeric types correct
- Audit log (quoted "user" column) reads/writes
- Graceful SIGTERM: HTTP close → pool drain

## Known follow-ups
- The test suite under `tests/` was written for hermetic SQLite files
  (`DB_PATH`); it needs a PostgreSQL test database (e.g. Testcontainers or
  a CI service) to run. Not migrated in this pass.
- Note numbering (CN/DN) relies on the UNIQUE(org_id, number) constraint as
  the backstop under concurrency (SQLite was single-writer; PostgreSQL is
  not). Consider a sequence per org if collisions ever surface in logs.
