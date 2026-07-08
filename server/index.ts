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

const applied = runMigrations();
if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);

// TASK 1: idempotent FX account seeds for every existing org (new orgs get
// them in seedChartOfAccounts at registration time).
for (const { id } of db.prepare("SELECT id FROM orgs").all() as Array<{ id: number }>) {
  ensureFxAccounts(id);
}

const app = express();
app.disable("x-powered-by");
app.use(attachSession);
app.use(buildRouter());
app.use(express.static(path.join(__dirname, "..", "client")));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`LedgerLite listening on :${port}`));

startWebhookWorker();
