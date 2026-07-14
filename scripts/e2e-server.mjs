// ============================================================================
// E2E app server launcher (used by playwright.config.ts `webServer`)
// ============================================================================
// Starts the PRODUCTION build of the app (node dist/index.mjs) against a
// throwaway Postgres so Playwright can drive real signup → invoice → payment →
// trial-balance flows end to end.
//
//   • DATABASE_URL set   → use it as-is (CI provides a Postgres service).
//   • DATABASE_URL unset → boot embedded-postgres, create a fresh DB, and point
//     the app at it. Torn down on exit.
//
// Requires a prior `npm run build` (serves dist/public + dist/index.mjs). The CI
// workflow builds before the e2e step; locally, run `npm run build` first.
//
// Port: E2E_PORT (default 5099).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.E2E_PORT || "5099";
let pg = null;
let child = null;

async function startEmbeddedPg() {
  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-e2e-pg-"));
  const port = 49152 + Math.floor(Math.random() * 16000);
  const epg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "password",
    port,
    persistent: false,
    createPostgresUser: (process.getuid?.() ?? 1000) === 0,
  });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("ll_e2e");
  return {
    url: `postgresql://postgres:password@localhost:${port}/ll_e2e`,
    stop: async () => {
      try { await epg.stop(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main() {
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("[e2e-server] no DATABASE_URL — booting embedded Postgres…");
    pg = await startEmbeddedPg();
    databaseUrl = pg.url;
  }

  child = spawn("node", ["dist/index.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      PORT,
      // Deterministic secrets so the app boots without external config.
      SESSION_SECRET: process.env.SESSION_SECRET || "e2e-session-secret-0123456789",
      APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY || "a".repeat(64),
      // Keep CSP report-only during E2E so nothing is blocked by the browser.
      CSP_ENFORCE: "false",
    },
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    console.log(`[e2e-server] app exited (${code})`);
    shutdown(code ?? 0);
  });
}

async function shutdown(code) {
  try { child?.kill("SIGKILL"); } catch { /* ignore */ }
  if (pg) { try { await pg.stop(); } catch { /* ignore */ } }
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

main().catch((e) => {
  console.error("[e2e-server] failed to start:", e);
  shutdown(1);
});
