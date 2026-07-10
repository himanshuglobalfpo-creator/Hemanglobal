// ============================================================================
// TEST HARNESS — one isolated, freshly-migrated database per test file
// ============================================================================
// BUG-003: `npm test` runs every test file in the same `node`/`tsx` process
// group but, when a shared $DATABASE_URL is provided (e.g. CI), all files used
// to hit the SAME database — so later files collided with rows earlier files
// seeded (every file assumes it owns org_id = 1). This harness gives each file
// its own database, migrated from scratch, in BOTH modes:
//
//   • $DATABASE_URL set  → CREATE a uniquely-named database on that server, run
//                          migrations into it, and DROP it on cleanup.
//   • $DATABASE_URL unset → boot a throwaway embedded-postgres on a random port
//                          with a fresh database (stopped + removed on cleanup).
//
// Either way the file gets a pristine schema and never sees another file's data.
// storage.ts opens its pool from $DATABASE_URL at import time, so the harness
// sets the URL BEFORE importing it; the test then imports any other server
// modules (which transitively use the same pool) after awaiting setupTestDb().
//
// Usage:
//   const t = await setupTestDb("payroll");
//   try { /* t.storage, t.pool, t.withOrg, t.seedOrgDefaults ... */ }
//   finally { await t.cleanup(); }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

export interface TestDb {
  pool: any;
  storage: any;
  withOrg: <T>(ctx: { orgId: number; userId: number }, fn: () => Promise<T> | T) => Promise<T> | T;
  seedOrgDefaults: (orgId: number) => Promise<void>;
  runMigrations: () => Promise<void>;
  /** Close the pool and destroy the throwaway database / embedded server. */
  cleanup: () => Promise<void>;
}

// Database identifiers can't be parameterized, so keep them strictly [a-z0-9_].
function safeName(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
  return `ll_test_${cleaned}_${crypto.randomBytes(5).toString("hex")}`;
}

async function createOnServer(baseUrl: string, dbName: string): Promise<() => Promise<void>> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  return async () => {
    const a = new pg.Client({ connectionString: baseUrl });
    await a.connect();
    try {
      // FORCE (PG13+) drops even with lingering connections; fall back if older.
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } catch {
      await a.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } finally {
      await a.end();
    }
  };
}

async function bootEmbedded(label: string): Promise<{ url: string; stop: () => Promise<void> }> {
  let EmbeddedPostgres: any;
  try {
    EmbeddedPostgres = (await import("embedded-postgres")).default;
  } catch {
    console.error("This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`.");
    process.exit(1);
  }
  const dbName = safeName(label);
  // Random ephemeral port; retry a few times in case one is momentarily taken.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 49152 + Math.floor(Math.random() * 16000);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ll-pg-${label}-`));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "postgres", password: "password", port,
      persistent: false, createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    try {
      await epg.initialise();
      await epg.start();
      await epg.createDatabase(dbName);
      return {
        url: `postgresql://postgres:password@localhost:${port}/${dbName}`,
        stop: async () => { await epg.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }); },
      };
    } catch (e) {
      lastErr = e;
      try { await epg.stop(); } catch { /* ignore */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  throw new Error(`Failed to start embedded-postgres after retries: ${String(lastErr)}`);
}

/**
 * Provision a private, freshly-migrated database for one test file and return
 * handles to the storage layer bound to it. Always `await t.cleanup()` in a
 * finally block.
 */
export async function setupTestDb(label: string): Promise<TestDb> {
  let dropDb: (() => Promise<void>) | null = null;
  let stopServer: (() => Promise<void>) | null = null;

  if (process.env.DATABASE_URL) {
    // Shared server (CI): carve out a private database on it.
    const baseUrl = process.env.DATABASE_URL;
    const dbName = safeName(label);
    dropDb = await createOnServer(baseUrl, dbName);
    const u = new URL(baseUrl);
    u.pathname = `/${dbName}`;
    process.env.DATABASE_URL = u.toString();
  } else {
    const embedded = await bootEmbedded(label);
    process.env.DATABASE_URL = embedded.url;
    stopServer = embedded.stop;
  }

  // Import storage AFTER DATABASE_URL is set (its pool is created at import).
  const storageMod: any = await import("../server/storage");
  const { withOrg } = await import("../server/org-scope");
  await storageMod.runMigrations();

  const cleanup = async () => {
    try { await storageMod.pool.end(); } catch { /* ignore */ }
    if (dropDb) await dropDb().catch(() => {});
    if (stopServer) await stopServer();
  };

  return {
    pool: storageMod.pool,
    storage: storageMod.storage,
    withOrg,
    seedOrgDefaults: storageMod.seedOrgDefaults,
    runMigrations: storageMod.runMigrations,
    cleanup,
  };
}
