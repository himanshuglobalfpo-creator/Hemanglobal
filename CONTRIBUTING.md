# Contributing to LedgerLite

## Development

```bash
npm ci
npm run dev          # http://localhost:5000
npm test             # full server suite (embedded Postgres if no $DATABASE_URL)
npm run check        # tsc --noEmit
npm run lint
```

`docker-compose up` brings up Postgres + a MinIO object store for local dev.

## The pipeline (what must pass)

Every PR runs, in order (see `.github/workflows/ci.yml`):

1. **lint** (ESLint) → **typecheck** (`tsc`) → **API contract** (client paths ↔
   server routes) → **client unit tests**
2. **server integration suite** (`npm test`, real Postgres + MinIO) → **build** →
   **prod-smoke** (boot the shipped `dist/index.mjs`, require `/api/health/ready`
   = 200) → **Playwright e2e** against the built artifact
3. **dependency audit** (fails on HIGH/CRITICAL in production deps)

These are required status checks; `main` cannot receive a change that fails them.
After merge, `deploy.yml` ships staging; a `v*` tag ships production behind a
manual approval. See `DEPLOY.md`.

## Adding a feature

- One focused, tested change per PR. Add a test that exercises the new behavior
  and wire it into the `test` script in `package.json`.
- Keep every business query org-scoped — the `org_scope_guard` test fails the
  build otherwise. If a query is legitimately cross-org, add it to that test's
  allow-list with a comment explaining why.
- No secrets or PII in logs (the `log_redaction` test greps for them).

## MIGRATION SAFETY (read before changing the schema)

Migrations live in `migrations/pg/`, are applied in filename order at boot, each
in its own transaction, and are tracked in `schema_migrations` so each runs
exactly once. Deploys are rolling/blue-green: **old and new code run against the
same database at the same time** during the swap. Therefore:

1. **Additive-only in the same release as the code that reads it.** A migration
   that ships in release N may only ADD things (new nullable column, new table,
   new index) — never rename, drop, narrow a type, or add a NOT NULL without a
   default. The old still-running code must keep working against the new schema.

2. **Destructive changes ship one release later — as a two-step.**
   - Release N: stop writing the column/table (code change) + add any
     replacement (additive).
   - Release N+1 (after N is fully rolled out and proven): the migration that
     DROPs or renames the now-unused object.

3. **Backfills are separate from schema changes.** Add the nullable column
   (release N), backfill in a background/idempotent job, then enforce NOT NULL
   in a later migration once every row is populated.

4. **Every migration is idempotent** (`IF NOT EXISTS`, guarded `DO $$…$$`) so a
   re-run or a partial-then-retried deploy is safe.

Rule of thumb: if rolling back the *code* while leaving the *migration* applied
would break the old code, the migration is not additive — split it.

## Commit / PR hygiene

- Clear, imperative commit messages describing the change and its cross-module
  impact.
- Update the relevant doc (`README.md`, `RUNBOOK.md`, `DEPLOY.md`,
  `OBSERVABILITY.md`, `SECURITY.md`) when behavior or ops change.
