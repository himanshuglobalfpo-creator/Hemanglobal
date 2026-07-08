/**
 * server/index.ts — application entrypoint.
 * Boot order: migrations → idempotent per-org seeds → HTTP server → webhook worker.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, runMigrations } from "./db.js";
import { buildRouter } from "./routes.js";
import { attachSession } from "./auth.js";
import { ensureFxAccounts } from "./storage.js";
import { startWebhookWorker } from "./webhooks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fail fast: running production with the dev fallback vault key would mean
// TOTP secrets are encrypted with a publicly-known key.
if (process.env.NODE_ENV === "production" && !process.env.VAULT_KEY) {
  console.error("FATAL: VAULT_KEY must be set in production (see .env.example)");
  process.exit(1);
}

const applied = runMigrations();
if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);

// TASK 1: idempotent FX account seeds for every existing org (new orgs get
// them in seedChartOfAccounts at registration time).
for (const { id } of db.prepare("SELECT id FROM orgs").all() as Array<{ id: number }>) {
  ensureFxAccounts(id);
}

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  // The client is fully self-contained (no CDNs), so a strict CSP is free.
  // style-src allows inline <style> because printable documents/statements
  // embed their print CSS; scripts remain 'self'-only.
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  next();
});
app.use(attachSession);
app.use(buildRouter());
app.use(express.static(path.join(__dirname, "..", "client")));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`LedgerLite listening on :${port}`));

startWebhookWorker();
