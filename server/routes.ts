import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  insertAccountSchema,
  updateAccountSchema,
  insertItemSchema,
  updateItemSchema,
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  receivePurchaseOrderSchema,
  createEstimateSchema,
  updateEstimateSchema,
  convertEstimateSchema,
  createFixedAssetSchema,
  updateFixedAssetSchema,
  disposeFixedAssetSchema,
  postDepreciationQuerySchema,
  revalueFxSchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  createPayrollRunSchema,
  payPayrollLiabilitiesSchema,
  insertCustomerSchema,
  insertVendorSchema,
  postJournalEntrySchema,
  createInvoiceSchema,
  createBillSchema,
  payInvoiceSchema,
  payBillSchema,
  postBankTransactionSchema,
  importBankTransactionsSchema,
  matchBankTransactionSchema,
  bankRuleSchema,
  bankRuleUpdateSchema,
  startReconciliationSchema,
  toggleReconItemSchema,
  createRecurringSchema,
  updateRecurringSchema,
  reclassifySchema,
  taxCodeSchema,
  closePeriodSchema,
  yearEndCloseSchema,
  sendInvoiceSchema,
  nexusStateSchema,
  createCreditNoteSchema,
  createDebitNoteSchema,
  applyCreditNoteSchema,
  applyDebitNoteSchema,
  voidNoteSchema,
  paginationQuerySchema,
  nextNumberQuerySchema,
  upsertFxRateSchema,
  createBudgetSchema,
  setBudgetLinesSchema,
  reportRangeSchema,
  createWebhookSchema,
  updateWebhookSchema,
} from "@shared/schema";
import { toCents, formatMoney } from "@shared/money";
import { z } from "zod";
import crypto from "node:crypto";
import express from "express";
import { storage, dbHealthCheck, pool } from "./storage";
import * as noteService from "./creditNoteService";
import { plaidStatus, createLinkToken, exchangePublicToken, syncTransactions, handlePlaidWebhook } from "./plaid";
import { streamInvoicePdf, streamBillPdf, streamCustomerStatementPdf, streamVendorStatementPdf, streamCreditNotePdf, streamDebitNotePdf } from "./pdf";
import { sendEmail, smtpStatus, appBaseUrl } from "./email";
import { attachSession, requireAuth, requireOrg, requireRole, startSessionCleanup } from "./auth";
import { csrfProtect } from "./csrf";
import { orgScopeMiddleware, currentOrgId } from "./org-scope";
import { registerAuthRoutes } from "./auth-routes";
import { registerStripeRoutes, stripeStatus, stripeOrgStatus } from "./stripe";
import { calculateSalesTax, validateAddress, taxjarStatus } from "./taxjar";
import { publicLimiter, writeLimiter, importLimiter } from "./rate-limit";
import { logger } from "./logger";
import { mapDbError } from "./db-errors";
import { metricsMiddleware, metricsHandler } from "./metrics";
import { fileDriver, ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_WHITELIST } from "./files";
import { toCsv, csvMoney, type CsvColumn } from "./csv";
import * as importers from "./importers";
import { assertSafeWebhookUrl, signWebhookPayload, startWebhookWorker } from "./webhooks";

// Heuristic: any Error whose message looks like a business-rule violation
// (rather than an unexpected crash) gets a 400 instead of 500.
const USER_ERROR_PATTERNS = [
  /not found/i,
  /missing/i,
  /required/i,
  /must be/i,
  /must have/i,
  /cannot /i,
  /already /i,
  /invalid/i,
  /exceeds/i,
  /unbalanced/i,
  /period is closed/i,
  /locked/i,
  /unrecognized/i,
];

// Parse a positive integer ID from a string. Throws a 400-able error for NaN/negative input.
function parseId(raw: unknown, label = "id"): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: "${raw}" is not a positive integer`);
  }
  return n;
}

// Validate ISO date string YYYY-MM-DD. Returns the input if valid, throws otherwise.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(raw: unknown, label = "date"): string {
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) {
    throw new Error(`Invalid ${label}: expected YYYY-MM-DD format, got "${raw}"`);
  }
  // Verify the date is real (rejects 2026-02-30 etc.)
  const d = new Date(raw + "T00:00:00Z");
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new Error(`Invalid ${label}: "${raw}" is not a real calendar date`);
  }
  return raw;
}



// Escape untrusted values interpolated into server-rendered HTML (public share page).
// Customer names, invoice numbers, notes, and line descriptions are all user-supplied —
// without this, an org user could plant <script> that runs in invoice recipients' browsers.
function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Optimistic concurrency (light): PATCH bodies may carry ifUnmodifiedSince
// (the updatedAt the client last read). If the row changed after that instant,
// 409 so the client reloads instead of silently clobbering someone's edit.
// ---------------------------------------------------------------------------
function assertUnmodifiedSince(row: { updatedAt?: string | null } | undefined, ifUnmodifiedSince?: string): void {
  if (!ifUnmodifiedSince || !row?.updatedAt) return;
  const current = new Date(row.updatedAt).getTime();
  const asOf = new Date(ifUnmodifiedSince).getTime();
  if (Number.isNaN(asOf)) return; // malformed timestamp: skip the check, not the save
  if (current > asOf) {
    const err: any = new Error("Record was modified by someone else. Reload and retry.");
    err.httpStatus = 409;
    throw err;
  }
}

// Single place every route helper funnels errors through, so the mapping order
// is identical for sync and async handlers:
//   1. Zod validation      → 400 with field details
//   2. explicit httpStatus  → honored verbatim (e.g. 409 duplicate-name/conflict)
//   3. raw Postgres error   → sanitized {status,message} (BUG-004); raw driver
//                             text/constraint stays in the structured log only
//   4. business-rule text   → 400 (USER_ERROR_PATTERNS)
//   5. anything else        → 500 with a generic message (never leak internals)
function respondError(res: Response, err: any): void {
  if (res.headersSent) return; // response already streamed; nothing to add
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.errors });
    return;
  }
  // Errors can carry an explicit HTTP status (e.g. 409 optimistic-concurrency
  // conflicts, duplicate-name detection) — honor it before any other mapping.
  if (typeof err?.httpStatus === "number") {
    const body: Record<string, unknown> = { error: err.message };
    // Duplicate-name detection (BUG-006) attaches the existing record so the
    // client can offer "use existing / create anyway".
    if (err.existing !== undefined) body.existing = err.existing;
    res.status(err.httpStatus).json(body);
    return;
  }
  // Raw Postgres driver error → friendly envelope. Log the full detail first.
  const friendly = mapDbError(err);
  if (friendly) {
    logger.error("Database error", {
      reqId: (res.req as any)?.reqId,
      path: (res.req as any)?.path,
      status: friendly.status,
      pgCode: err?.code ?? err?.cause?.code,
      pgDetail: err?.detail ?? err?.cause?.detail,
      pgConstraint: err?.constraint ?? err?.cause?.constraint,
    });
    res.status(friendly.status).json({ error: friendly.message });
    return;
  }
  const msg: string = err?.message || "Server error";
  if (USER_ERROR_PATTERNS.some((p) => p.test(msg))) {
    res.status(400).json({ error: msg });
  } else {
    // res.req is the paired request — carries the reqId minted in index.ts,
    // so this 5xx line and the client's x-request-id header correlate 1:1.
    logger.error("Unhandled route error", {
      reqId: (res.req as any)?.reqId,
      path: (res.req as any)?.path,
      error: msg,
      stack: err?.stack?.split("\n").slice(0, 5).join(" | "),
    });
    res.status(500).json({ error: msg });
  }
}

async function handle<T>(res: Response, fn: () => T | Promise<T>) {
  try {
    const out = await fn();
    // Routes that stream their own response (CSV exports, file downloads)
    // finish inside fn() — do not double-send.
    if (!res.headersSent) res.json(out);
  } catch (err: any) {
    respondError(res, err);
  }
}

function handleAsync<T>(res: Response, fn: () => Promise<T>) {
  fn()
    .then((out) => { if (!res.headersSent) res.json(out); })
    .catch((err: any) => respondError(res, err));
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ============================================================================
  // AUTH — must come BEFORE the business routes so req.user/req.org are populated.
  // ============================================================================
  // attachSession runs on every request. It populates req.user/req.org if the
  // request carries a valid session cookie or Bearer token. It does NOT enforce
  // auth — that's the job of requireAuth/requireOrg on individual routes.
  app.use(attachSession);

  // CSRF (Task 2): double-submit cookie check on every state-changing /api
  // request. Mounted AFTER attachSession (Bearer detection) and BEFORE the
  // auth gate — a forged request should die on CSRF before touching auth.
  app.use(csrfProtect);

  // Write rate limit (Task 6): one blanket limiter for every mutating business
  // route — 120/min per user — instead of decorating ~40 routes individually.
  // Auth endpoints have their own tighter authLimiter (mounted in
  // registerAuthRoutes); webhooks are provider-driven and signature-verified,
  // so neither goes through this budget.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (req.path.startsWith("/auth/")) return next();
    if (req.path === "/stripe/webhook" || req.path === "/plaid/webhook") return next();
    return writeLimiter(req, res, next);
  });

  // Metrics counting — before the auth gate so denied requests are measured.
  app.use(metricsMiddleware);

  // Org-scope: wrap every request in an AsyncLocalStorage context so that
  // storage methods can read the active org via currentOrgId().
  app.use(orgScopeMiddleware);

  // Register the auth-specific routes (signup/login/logout/me/etc.)
  registerAuthRoutes(app);

  // Stripe (lazy-loads SDK; no-ops gracefully if STRIPE_SECRET_KEY missing).
  // Note: the webhook route /api/stripe/webhook is mounted here but does NOT
  // require auth — Stripe signs the body and we verify the signature.
  registerStripeRoutes(app);

  // Stripe status endpoint. With an active org it also reports whether the
  // org's clearing account is configured — the UI gates "online payments"
  // on `onlinePaymentsReady`.
  app.get("/api/stripe/status", async (req, res) => {
    if (req.org) {
      res.json(await stripeOrgStatus(req.org.id));
    } else {
      res.json(stripeStatus());
    }
  });

  // Auth gate for everything below /api/* EXCEPT explicitly-public routes.
  // Public: /api/auth/*, /api/health, /api/stripe/webhook, /api/plaid/webhook
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    if (req.path === "/health" || req.path === "/healthz" || req.path.startsWith("/health/")) return next();
    if (req.path === "/metrics") return next();           // guarded by METRICS_TOKEN, not sessions
    if (req.path === "/stripe/webhook") return next();    // Stripe signs the body
    if (req.path === "/plaid/webhook") return next();     // Plaid → us
    if (!req.user) {
      res.status(401).json({ error: "Authentication required. POST /api/auth/login." });
      return;
    }
    // Email verification enforcement (24h grace so signup→first-use stays
    // frictionless). /api/auth/* is exempted above, so an unverified user can
    // always verify, resend the email, or log out.
    if (!req.user.emailVerified) {
      const createdMs = req.user.createdAt ? new Date(req.user.createdAt).getTime() : 0;
      const ageMs = Date.now() - createdMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        res.status(403).json({ error: "Please verify your email to continue.", code: "EMAIL_UNVERIFIED" });
        return;
      }
    }
    if (req.path.startsWith("/orgs")) return next();
    if (!req.org) {
      res.status(403).json({ error: "No active organization. Pick one with POST /api/auth/switch-org." });
      return;
    }
    // Owner MFA enforcement (7-day grace, mirroring the email-verification
    // gate): owners hold the keys to the books — after grace, business APIs
    // refuse until TOTP is enabled. /api/auth/* stays reachable for setup.
    if (req.role === "owner" && !req.user.totpEnabled) {
      const createdMs = req.user.createdAt ? new Date(req.user.createdAt).getTime() : 0;
      if (Date.now() - createdMs > 7 * 24 * 60 * 60 * 1000) {
        res.status(403).json({ error: "Owners must enable two-factor authentication to continue.", code: "MFA_REQUIRED" });
        return;
      }
    }
    next();
  });

  // ---------- Health: liveness vs readiness split ----------
  // /api/health/live  — process is up; NEVER touches the DB. Kubernetes-style
  //                     liveness: restarting the pod won't fix a down database,
  //                     so DB state must not fail liveness.
  // /api/health/ready — DB-checking readiness (SELECT 1); load balancers use
  //                     this to decide whether to route traffic here.
  // /api/health       — alias of ready, for backward compatibility.
  app.get("/api/health/live", (_req, res) => {
    res.json({ ok: true });
  });
  const readyHandler = async (_req: Request, res: Response) => {
    const health = await dbHealthCheck();
    if (health.db === "ok") {
      res.json({ ...health, ok: true, ts: new Date().toISOString() });
    } else {
      res.status(503).json({ ...health, ok: false, ts: new Date().toISOString() });
    }
  };
  app.get("/api/health/ready", readyHandler);
  app.get("/api/health", readyHandler);

  // ---------- Metrics (Prometheus text; guarded by METRICS_TOKEN) ----------
  // Route only — the counting middleware is mounted BEFORE the auth gate (see
  // top of registerRoutes) so 401/403 responses are measured too.
  app.get("/api/metrics", metricsHandler);

  // ---------- Accounts ----------
  // ---------- Settings: auto-number preview ----------
  // Read-only preview of the next document number (does NOT increment the
  // sequence) so forms can show the upcoming value.
  app.get("/api/settings/next-number", (req, res) =>
    handle(res, () => {
      const { kind } = nextNumberQuerySchema.parse(req.query);
      return storage.previewNextNumber(kind);
    })
  );

  // ---------- Outbound webhooks ----------
  startWebhookWorker(); // 30s unref'd interval; idempotent to call

  app.get("/api/webhooks", requireRole("owner", "admin"), (_req, res) =>
    handle(res, async () =>
      (await pool.query(
        `SELECT id, url, events, is_active AS "isActive", created_at AS "createdAt" FROM webhooks WHERE org_id = $1 ORDER BY id`,
        [currentOrgId()]
      )).rows.map((w: any) => ({ ...w, events: JSON.parse(w.events) })) // secret intentionally never returned
    )
  );
  app.post("/api/webhooks", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const data = createWebhookSchema.parse(req.body);
      await assertSafeWebhookUrl(data.url); // SSRF guard at CREATE time
      const row = (await pool.query(
        `INSERT INTO webhooks (org_id, url, secret, events, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [currentOrgId(), data.url, data.secret, JSON.stringify(data.events), data.isActive]
      )).rows[0];
      await storage.audit("create", "webhook", Number(row.id), `Webhook ${data.url} subscribed to ${data.events.join(", ")}`);
      return { id: Number(row.id) };
    })
  );
  app.patch("/api/webhooks/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = updateWebhookSchema.parse(req.body);
      if (data.url) await assertSafeWebhookUrl(data.url);
      const existing = (await pool.query(`SELECT id FROM webhooks WHERE id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0];
      if (!existing) throw new Error("Webhook not found");
      await pool.query(
        `UPDATE webhooks SET url = COALESCE($3, url), secret = COALESCE($4, secret),
                events = COALESCE($5, events), is_active = COALESCE($6, is_active)
          WHERE id = $1 AND org_id = $2`,
        [id, currentOrgId(), data.url ?? null, data.secret ?? null, data.events ? JSON.stringify(data.events) : null, data.isActive ?? null]
      );
      return { ok: true };
    })
  );
  app.delete("/api/webhooks/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const r = await pool.query(`DELETE FROM webhooks WHERE id = $1 AND org_id = $2`, [parseId(req.params.id), currentOrgId()]);
      if ((r.rowCount ?? 0) === 0) throw new Error("Webhook not found");
      return { ok: true };
    })
  );
  // Test ping: enqueue a synthetic event for JUST this webhook (bypasses the
  // subscription filter so it works regardless of the events list).
  app.post("/api/webhooks/:id/test", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const w = (await pool.query(`SELECT id FROM webhooks WHERE id = $1 AND org_id = $2 AND is_active = true`, [id, currentOrgId()])).rows[0];
      if (!w) throw new Error("Webhook not found or inactive");
      const payload = JSON.stringify({ event: "ping", orgId: currentOrgId(), at: new Date().toISOString(), data: { message: "LedgerLite webhook test" } });
      await pool.query(
        `INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload) VALUES ($1, $2, 'ping', $3)`,
        [currentOrgId(), id, payload]
      );
      return { ok: true, message: "Ping queued — delivered within 30 seconds." };
    })
  );
  app.get("/api/webhooks/:id/deliveries", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const w = (await pool.query(`SELECT id FROM webhooks WHERE id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0];
      if (!w) throw new Error("Webhook not found");
      return (await pool.query(
        `SELECT id, event, status, attempts, response_code AS "responseCode", next_attempt_at AS "nextAttemptAt", created_at AS "createdAt"
           FROM webhook_deliveries WHERE webhook_id = $1 AND org_id = $2 ORDER BY id DESC LIMIT 50`,
        [id, currentOrgId()]
      )).rows;
    })
  );

  // ---------- Data import (CSV) ----------
  // Body: raw text/csv OR JSON { csv: "...", asOfDate? }. All support
  // ?dryRun=true (validate only); invoices also support ?partial=true.
  const csvBody = (req: Request): string => {
    if (typeof req.body === "string") return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
    if (req.body && typeof req.body.csv === "string") return req.body.csv;
    throw new Error("Provide CSV as a text/csv body or JSON { csv: \"...\" }");
  };
  const importText = express.text({ type: ["text/csv", "text/plain"], limit: "10mb" });
  const flag = (req: Request, name: string) => String(req.query[name] || "") === "true";

  app.post("/api/import/customers", importLimiter, importText, (req, res) =>
    handle(res, () => importers.importCustomers(csvBody(req), flag(req, "dryRun"))));
  app.post("/api/import/vendors", importLimiter, importText, (req, res) =>
    handle(res, () => importers.importVendors(csvBody(req), flag(req, "dryRun"))));
  app.post("/api/import/chart-of-accounts", importLimiter, importText, (req, res) =>
    handle(res, () => importers.importChartOfAccounts(csvBody(req), flag(req, "dryRun"))));
  app.post("/api/import/invoices", importLimiter, importText, (req, res) =>
    handle(res, () => importers.importInvoices(csvBody(req), flag(req, "dryRun"), flag(req, "partial"))));
  app.post("/api/import/opening-balances", importLimiter, importText, (req, res) =>
    handle(res, () => importers.importOpeningBalances(csvBody(req), String((req.body?.asOfDate ?? req.query.asOfDate) || ""), flag(req, "dryRun"))));

  // ---------- Report pack (Phase 3) ----------
  // Every report accepts ?format=csv and streams RFC-4180 CSV via the shared
  // toCsv() helper; money renders as plain decimals for spreadsheets.
  const sendReport = <T,>(res: Response, name: string, format: string, rows: T[], columns: CsvColumn<T>[]) => {
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
      res.send(toCsv(rows, columns));
      return true;
    }
    return false;
  };

  app.get("/api/reports/sales-by-customer", (req, res) =>
    handle(res, async () => {
      const { from, to, format } = reportRangeSchema.parse(req.query);
      const rows = await storage.salesByCustomer(from, to);
      if (sendReport(res, `sales-by-customer-${from}-to-${to}`, format, rows, [
        { key: "customerName", header: "Customer" },
        { key: (r: any) => csvMoney(r.invoiced), header: "Invoiced" },
        { key: (r: any) => csvMoney(r.credited), header: "Credited" },
        { key: (r: any) => csvMoney(r.net), header: "Net" },
        { key: (r: any) => csvMoney(r.paid), header: "Paid" },
        { key: (r: any) => csvMoney(r.balance), header: "Balance" },
      ])) return undefined as any;
      return rows;
    })
  );

  app.get("/api/reports/expenses-by-vendor", (req, res) =>
    handle(res, async () => {
      const { from, to, format } = reportRangeSchema.parse(req.query);
      const rows = await storage.expensesByVendor(from, to);
      if (sendReport(res, `expenses-by-vendor-${from}-to-${to}`, format, rows, [
        { key: "vendorName", header: "Vendor" },
        { key: (r: any) => csvMoney(r.billed), header: "Billed" },
        { key: (r: any) => csvMoney(r.debited), header: "Debited" },
        { key: (r: any) => csvMoney(r.net), header: "Net" },
        { key: (r: any) => csvMoney(r.paid), header: "Paid" },
        { key: (r: any) => csvMoney(r.balance), header: "Balance" },
      ])) return undefined as any;
      return rows;
    })
  );

  app.get("/api/reports/profit-loss-monthly", (req, res) =>
    handle(res, async () => {
      const { from, to, format } = reportRangeSchema.parse(req.query);
      const report = await storage.profitLossMonthly(from, to);
      if (format === "csv") {
        const cols: CsvColumn<any>[] = [
          { key: "code", header: "Code" },
          { key: "name", header: "Account" },
          { key: "type", header: "Type" },
          ...report.months.map((m) => ({ key: (r: any) => csvMoney(r.byMonth[m] ?? 0), header: m })),
          { key: (r: any) => csvMoney(r.total), header: "Total" },
        ];
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="profit-loss-monthly-${from}-to-${to}.csv"`);
        res.send(toCsv(report.accounts, cols));
        return undefined as any;
      }
      return report;
    })
  );

  // ---------- Budgets ----------
  app.get("/api/budgets", (_req, res) => handle(res, () => storage.listBudgets()));
  app.get("/api/budgets/:id", (req, res) =>
    handle(res, async () => {
      const b = await storage.getBudget(parseId(req.params.id));
      if (!b) throw new Error("Budget not found");
      return b;
    })
  );
  app.post("/api/budgets", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.createBudget(createBudgetSchema.parse(req.body)))
  );
  app.put("/api/budgets/:id/lines", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const { lines } = setBudgetLinesSchema.parse(req.body);
      return storage.setBudgetLines(parseId(req.params.id), lines);
    })
  );
  app.delete("/api/budgets/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.deleteBudget(parseId(req.params.id)))
  );

  app.get("/api/reports/budget-vs-actual", (req, res) =>
    handle(res, async () => {
      const { from, to, format } = reportRangeSchema.parse(req.query);
      const budgetId = parseId(String(req.query.budgetId || ""));
      const report = await storage.budgetVsActual(budgetId, from, to);
      if (sendReport(res, `budget-vs-actual-${from}-to-${to}`, format, report.rows, [
        { key: "code", header: "Code" },
        { key: "name", header: "Account" },
        { key: "type", header: "Type" },
        { key: (r: any) => csvMoney(r.budget), header: "Budget" },
        { key: (r: any) => csvMoney(r.actual), header: "Actual" },
        { key: (r: any) => csvMoney(r.variance), header: "Variance" },
        { key: (r: any) => (r.variancePct === null ? "" : r.variancePct + "%"), header: "Variance %" },
      ])) return undefined as any;
      return report;
    })
  );

  // ---------- Attachments ----------
  // Upload design decision: raw body (express.raw, 10MB) with metadata in
  // query params instead of multipart. Rationale: a hand-rolled multipart
  // parser is the simpler-LOOKING but bug-prone option (boundary parsing,
  // CRLF edge cases, partial chunks); raw upload is one code path, exact
  // size enforcement for free, and we own the only client. Usage:
  //   POST /api/attachments?entityType=bill&entityId=7&filename=receipt.pdf
  //   Content-Type: application/pdf   (body = the file bytes)
  app.post(
    "/api/attachments",
    express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES }),
    (req, res) =>
      handle(res, async () => {
        const entityType = String(req.query.entityType || "");
        const entityId = parseId(String(req.query.entityId || ""));
        const filename = String(req.query.filename || "").slice(0, 255);
        const mimeType = (req.headers["content-type"] || "").split(";")[0].trim();
        if (!filename) throw new Error("filename query parameter is required");
        if (!ATTACHMENT_MIME_WHITELIST[mimeType]) {
          throw new Error(`Unsupported file type "${mimeType}". Allowed: pdf, png, jpg, webp, csv, xlsx.`);
        }
        const body: Buffer = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new Error("Empty upload body");
        if (body.length > ATTACHMENT_MAX_BYTES) throw new Error("File exceeds the 10MB limit");
        // Entity must exist IN THIS ORG before we touch blob storage.
        await storage.assertAttachmentEntity(entityType, entityId);
        const storageKey = `${req.org!.id}/${crypto.randomUUID()}`;
        await fileDriver().put(storageKey, body, mimeType);
        const { id } = await storage.createAttachment({
          entityType, entityId, filename, mimeType, sizeBytes: body.length, storageKey,
        });
        return { id, filename, mimeType, sizeBytes: body.length };
      })
  );
  app.get("/api/attachments", (req, res) =>
    handle(res, async () => {
      const entityType = String(req.query.entityType || "");
      const entityId = parseId(String(req.query.entityId || ""));
      await storage.assertAttachmentEntity(entityType, entityId);
      return storage.listAttachments(entityType, entityId);
    })
  );
  app.get("/api/attachments/:id/download", async (req, res) => {
    try {
      const att = await storage.getAttachment(parseId(req.params.id));
      if (!att) { res.status(404).json({ error: "Attachment not found" }); return; }
      const data = await fileDriver().get(att.storageKey);
      res.setHeader("Content-Type", att.mimeType);
      res.setHeader("Content-Length", String(data.length));
      res.setHeader("Content-Disposition", `attachment; filename="${att.filename.replace(/"/g, "")}"`);
      res.send(data);
    } catch (err: any) {
      logger.error("Attachment download failed", { reqId: (req as any).reqId, error: err?.message });
      res.status(500).json({ error: "Download failed" });
    }
  });
  app.delete("/api/attachments/:id", (req, res) =>
    handle(res, async () => {
      const { storageKey } = await storage.deleteAttachment(parseId(req.params.id));
      await fileDriver().delete(storageKey); // row first, then blob — an orphan blob beats a dangling row
      return { ok: true };
    })
  );

  // ---------- Settings: FX rates (manual rate management) ----------
  app.get("/api/settings/fx-rates", (_req, res) => handle(res, () => storage.listFxRates()));
  app.put("/api/settings/fx-rates", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const data = upsertFxRateSchema.parse(req.body);
      await storage.upsertFxRate(data);
      return { ok: true };
    })
  );

  // ---------- FX revaluation (period-end unrealized adjustment) ----------
  app.get("/api/fx/revaluations", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listFxRevaluations(limit, offset);
    })
  );
  app.get("/api/fx/revaluations/:id", (req, res) =>
    handle(res, async () => {
      const rev = await storage.getFxRevaluation(parseId(req.params.id));
      if (!rev) throw new Error("FX revaluation not found");
      return rev;
    })
  );
  app.post("/api/fx/revalue", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.revalueFx(revalueFxSchema.parse(req.body)))
  );
  app.post("/api/fx/revalue/:id/reverse", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, () => storage.reverseFxRevaluation(parseId(req.params.id)))
  );

  // ---------- Payroll ----------
  app.get("/api/payroll/employees", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listEmployees(limit, offset);
    })
  );
  app.get("/api/payroll/employees/:id", (req, res) =>
    handle(res, async () => {
      const emp = await storage.getEmployee(parseId(req.params.id));
      if (!emp) throw new Error("Employee not found");
      return emp;
    })
  );
  app.post("/api/payroll/employees", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.createEmployee(createEmployeeSchema.parse(req.body)))
  );
  app.patch("/api/payroll/employees/:id", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = updateEmployeeSchema.parse(body);
      assertUnmodifiedSince(await storage.getEmployee(id), ifUnmodifiedSince);
      return storage.updateEmployee(id, data);
    })
  );
  app.delete("/api/payroll/employees/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.deleteEmployee(parseId(req.params.id)))
  );

  app.get("/api/payroll/runs", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listPayrollRuns(limit, offset);
    })
  );
  app.get("/api/payroll/runs/:id", (req, res) =>
    handle(res, async () => {
      const run = await storage.getPayrollRun(parseId(req.params.id));
      if (!run) throw new Error("Pay run not found");
      return run;
    })
  );
  app.post("/api/payroll/runs", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.createPayrollRun(createPayrollRunSchema.parse(req.body)))
  );
  app.post("/api/payroll/runs/:id/post", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, () => storage.postPayrollRun(parseId(req.params.id)))
  );
  app.get("/api/payroll/runs/:id/employees/:employeeId/stub", (req, res) =>
    handle(res, () => storage.getPayStub(parseId(req.params.id), parseId(req.params.employeeId, "employeeId")))
  );

  // Pay payroll liabilities (remittance to tax agencies — QBO "Pay Taxes")
  app.get("/api/payroll/liabilities", (req, res) =>
    handle(res, () => storage.payrollLiabilityBalances(req.query.asOf as string | undefined))
  );
  app.post("/api/payroll/liabilities/pay", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.payPayrollLiabilities(payPayrollLiabilitiesSchema.parse(req.body)))
  );

  app.get("/api/accounts", (_req, res) => handle(res, () => storage.listAccounts()));
  app.post("/api/accounts", (req, res) =>
    handle(res, async () => {
      const data = insertAccountSchema.parse(req.body);
      return storage.createAccount(data);
    })
  );
  app.patch("/api/accounts/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = updateAccountSchema.parse(body);
      assertUnmodifiedSince(await storage.getAccount(id), ifUnmodifiedSince);
      return storage.updateAccount(id, data);
    })
  );

  // ---------- Items / Inventory ----------
  app.get("/api/items", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listItems(limit, offset);
    })
  );
  app.get("/api/items/:id", (req, res) =>
    handle(res, async () => {
      const item = await storage.getItem(parseId(req.params.id));
      if (!item) throw new Error("Item not found");
      return item;
    })
  );
  app.post("/api/items", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const data = insertItemSchema.parse(req.body);
      return storage.createItem(data);
    })
  );
  app.patch("/api/items/:id", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = updateItemSchema.parse(body);
      assertUnmodifiedSince(await storage.getItem(id), ifUnmodifiedSince);
      return storage.updateItem(id, data);
    })
  );
  app.delete("/api/items/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.deleteItem(parseId(req.params.id)))
  );

  // ---------- Purchase Orders ----------
  app.get("/api/purchase-orders", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listPurchaseOrders(limit, offset);
    })
  );
  app.get("/api/purchase-orders/:id", (req, res) =>
    handle(res, async () => {
      const po = await storage.getPurchaseOrder(parseId(req.params.id));
      if (!po) throw new Error("Purchase order not found");
      return po;
    })
  );
  app.post("/api/purchase-orders", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.createPurchaseOrder(createPurchaseOrderSchema.parse(req.body)))
  );
  app.patch("/api/purchase-orders/:id", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = updatePurchaseOrderSchema.parse(body);
      assertUnmodifiedSince(await storage.getPurchaseOrder(id), ifUnmodifiedSince);
      return storage.updatePurchaseOrder(id, data);
    })
  );
  app.delete("/api/purchase-orders/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.deletePurchaseOrder(parseId(req.params.id)))
  );
  app.post("/api/purchase-orders/:id/receive", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () =>
      storage.receivePurchaseOrder(parseId(req.params.id), receivePurchaseOrderSchema.parse(req.body))
    )
  );

  // ---------- Estimates (quotes) ----------
  app.get("/api/estimates", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listEstimates(limit, offset);
    })
  );
  app.get("/api/estimates/:id", (req, res) =>
    handle(res, async () => {
      const est = await storage.getEstimate(parseId(req.params.id));
      if (!est) throw new Error("Estimate not found");
      return est;
    })
  );
  app.post("/api/estimates", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.createEstimate(createEstimateSchema.parse(req.body)))
  );
  app.patch("/api/estimates/:id", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = updateEstimateSchema.parse(body);
      assertUnmodifiedSince(await storage.getEstimate(id), ifUnmodifiedSince);
      return storage.updateEstimate(id, data);
    })
  );
  app.delete("/api/estimates/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.deleteEstimate(parseId(req.params.id)))
  );
  app.post("/api/estimates/:id/convert", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.convertEstimate(parseId(req.params.id), convertEstimateSchema.parse(req.body ?? {})))
  );
  app.post("/api/estimates/:id/share", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const est = await storage.getEstimate(id);
      if (!est) throw new Error("Estimate not found");
      const recipient = (req.body?.email as string | undefined) || est.customer?.email || undefined;
      const expiresInDays = req.body?.expiresInDays ? Number(req.body.expiresInDays) : 90;
      const share = await storage.createEstimateShare(id, recipient, expiresInDays);
      const url = `${appBaseUrl()}/p/estimate/${share.token}`;
      return { share, url };
    })
  );

  // ---------- Fixed Assets & Depreciation ----------
  app.get("/api/fixed-assets", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listFixedAssets(limit, offset);
    })
  );
  app.get("/api/fixed-assets/:id", (req, res) =>
    handle(res, async () => {
      const asset = await storage.getFixedAssetDetail(parseId(req.params.id));
      if (!asset) throw new Error("Fixed asset not found");
      return asset;
    })
  );
  app.post("/api/fixed-assets", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.createFixedAsset(createFixedAssetSchema.parse(req.body)))
  );
  app.patch("/api/fixed-assets/:id", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = updateFixedAssetSchema.parse(body);
      assertUnmodifiedSince(await storage.getFixedAsset(id), ifUnmodifiedSince);
      return storage.updateFixedAsset(id, data);
    })
  );
  app.delete("/api/fixed-assets/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.deleteFixedAsset(parseId(req.params.id)))
  );
  app.post("/api/fixed-assets/:id/post-depreciation", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { period } = postDepreciationQuerySchema.parse(req.query);
      return storage.postDepreciation(id, period);
    })
  );
  app.post("/api/fixed-assets/:id/dispose", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => storage.disposeFixedAsset(parseId(req.params.id), disposeFixedAssetSchema.parse(req.body)))
  );

  // ---------- Customers ----------
  app.get("/api/customers", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listCustomers(limit, offset);
    })
  );
  app.post("/api/customers", (req, res) =>
    handle(res, async () => {
      const data = insertCustomerSchema.parse(req.body);
      // `force` bypasses duplicate-name detection (BUG-006). It is not part of
      // the insert schema, so read it from the raw body.
      const force = req.body?.force === true;
      return storage.createCustomer(data, { force });
    })
  );
  app.patch("/api/customers/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = insertCustomerSchema.partial().parse(body);
      assertUnmodifiedSince(await storage.getCustomer(id), ifUnmodifiedSince);
      const updated = await storage.updateCustomer(id, data);
      if (!updated) throw new Error("Customer not found");
      return updated;
    })
  );
  app.delete("/api/customers/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      await storage.deleteCustomer(parseId(req.params.id));
      return { ok: true };
    })
  );

  // ---------- Vendors ----------
  app.get("/api/vendors", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listVendors(limit, offset);
    })
  );
  app.post("/api/vendors", (req, res) =>
    handle(res, async () => {
      const data = insertVendorSchema.parse(req.body);
      const force = req.body?.force === true;
      return storage.createVendor(data, { force });
    })
  );
  app.patch("/api/vendors/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const { ifUnmodifiedSince, ...body } = req.body ?? {};
      const data = insertVendorSchema.partial().parse(body);
      assertUnmodifiedSince(await storage.getVendor(id), ifUnmodifiedSince);
      const updated = await storage.updateVendor(id, data);
      if (!updated) throw new Error("Vendor not found");
      return updated;
    })
  );
  app.delete("/api/vendors/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      await storage.deleteVendor(parseId(req.params.id));
      return { ok: true };
    })
  );

  // ---------- Journal ----------
  app.get("/api/journal", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listJournalEntries(limit, offset);
    })
  );
  app.post("/api/journal", (req, res) =>
    handle(res, async () => {
      const data = postJournalEntrySchema.parse(req.body);
      // Users type dollars in the journal form — convert ONCE at the boundary.
      // postJournalEntry then enforces the EXACT integer balance check
      // (totalDebitCents === totalCreditCents).
      return storage.postJournalEntry({
        ...data,
        lines: data.lines.map((l) => ({
          ...l,
          debit: toCents(l.debit || 0),
          credit: toCents(l.credit || 0),
        })),
      }, { futureDateCheck: true });
    })
  );

  // ---------- Invoices ----------
  app.get("/api/invoices", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listInvoices(limit, offset);
    })
  );
  app.get("/api/invoices/:id", (req, res) =>
    handle(res, () => storage.getInvoice(parseId(req.params.id)))
  );
  app.post("/api/invoices", (req, res) =>
    handleAsync(res, async () => {
      const data = createInvoiceSchema.parse(req.body);
      // Uses TaxJar automatically when configured AND the customer has a
      // shipping ZIP/state AND the org has a ship-from address; otherwise this
      // is exactly the old manual taxCodeId/taxRate path. Never fails on a
      // TaxJar outage — it falls back to the manual rate and logs a warning.
      return storage.createInvoiceWithAutoTax(data);
    })
  );
  app.post("/api/invoices/:id/pay", (req, res) =>
    handle(res, async () => {
      const data = payInvoiceSchema.parse({ ...req.body, invoiceId: parseId(req.params.id) });
      return storage.payInvoice(data);
    })
  );
  app.post("/api/invoices/:id/void", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.voidInvoice(parseId(req.params.id)))
  );

  // ---------- Bills ----------
  app.get("/api/bills", (req, res) =>
    handle(res, () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listBills(limit, offset);
    })
  );
  app.get("/api/bills/:id", (req, res) => handle(res, () => storage.getBill(parseId(req.params.id))));
  app.post("/api/bills", (req, res) =>
    handle(res, async () => {
      const data = createBillSchema.parse(req.body);
      return storage.createBill(data);
    })
  );
  app.post("/api/bills/:id/pay", (req, res) =>
    handle(res, async () => {
      const data = payBillSchema.parse({ ...req.body, billId: parseId(req.params.id) });
      return storage.payBill(data);
    })
  );
  app.post("/api/bills/:id/void", requireRole("owner", "admin"), (req, res) =>
    handle(res, () => storage.voidBill(parseId(req.params.id), req.body?.voidDate))
  );

  // ---------- Reports ----------
  app.get("/api/reports/trial-balance", (req, res) =>
    handle(res, () => storage.trialBalance(req.query.asOf as string | undefined))
  );
  app.get("/api/reports/profit-loss", (req, res) =>
    handle(res, async () => {
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      return storage.profitAndLoss(from, to);
    })
  );
  app.get("/api/reports/balance-sheet", (req, res) =>
    handle(res, async () => {
      const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
      return storage.balanceSheet(asOf);
    })
  );
  app.get("/api/reports/general-ledger", (req, res) =>
    handle(res, async () => {
      const accountId = parseId(req.query.accountId, "accountId");
      if (!accountId) throw new Error("accountId required");
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      return storage.generalLedger(accountId, from, to);
    })
  );
  app.get("/api/reports/ar-aging", (req, res) =>
    handle(res, () => storage.arAging(req.query.asOf as string | undefined))
  );
  app.get("/api/reports/inventory-valuation", (req, res) =>
    handle(res, () => storage.inventoryValuation(req.query.asOf as string | undefined))
  );
  app.get("/api/reports/ap-aging", (req, res) =>
    handle(res, () => storage.apAging(req.query.asOf as string | undefined))
  );
  app.get("/api/reports/cash-flow", (req, res) =>
    handle(res, async () => {
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      return storage.cashFlowStatement(from, to);
    })
  );
  app.get("/api/reports/customer-statement", (req, res) =>
    handle(res, async () => {
      const customerId = parseId(req.query.customerId, "customerId");
      if (!customerId) throw new Error("customerId required");
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      return storage.customerStatement(customerId, from, to);
    })
  );
  app.get("/api/reports/vendor-statement", (req, res) =>
    handle(res, async () => {
      const vendorId = parseId(req.query.vendorId, "vendorId");
      if (!vendorId) throw new Error("vendorId required");
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      return storage.vendorStatement(vendorId, from, to);
    })
  );

  // ---------- Credit notes (AR) ----------
  app.post("/api/credit-notes", (req, res) =>
    handle(res, async () => {
      const data = createCreditNoteSchema.parse(req.body); // orgId comes from the org context, never the body
      return noteService.createCreditNote(data);
    })
  );
  app.get("/api/credit-notes", (req, res) =>
    handle(res, () =>
      noteService.listCreditNotes({
        customerId: req.query.customerId ? parseId(req.query.customerId, "customerId") : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        dateFrom: req.query.dateFrom ? parseDate(req.query.dateFrom, "dateFrom") : undefined,
        dateTo: req.query.dateTo ? parseDate(req.query.dateTo, "dateTo") : undefined,
      })
    )
  );
  app.get("/api/credit-notes/:id", (req, res) =>
    handle(res, async () => {
      const note = await noteService.getCreditNote(parseId(req.params.id));
      if (!note) throw new Error("Credit note not found");
      return note;
    })
  );
  app.post("/api/credit-notes/:id/apply", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = applyCreditNoteSchema.parse(req.body);
      return noteService.applyCreditNote(id, data.invoiceId, data.amountToApply);
    })
  );
  app.post("/api/credit-notes/:id/unapply", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const applicationId = parseId(req.body?.applicationId, "applicationId");
      return noteService.unapplyCreditNote(id, applicationId);
    })
  );
  app.post("/api/credit-notes/:id/void", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = voidNoteSchema.parse(req.body);
      return noteService.voidCreditNote(id, data.reason);
    })
  );
  app.get("/api/credit-notes/:id/pdf", async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const note = await noteService.getCreditNote(id);
      if (!note) {
        res.status(404).json({ error: "Credit note not found" });
        return;
      }
      const customer = await storage.getCustomer(note.customerId);
      streamCreditNotePdf(res, {
        note: {
          number: note.number,
          date: note.date,
          status: note.status,
          reason: note.reason,
          subtotal: note.subtotal,
          tax: note.tax,
          total: note.total,
          appliedAmount: note.appliedAmount,
          remainingCredit: note.remainingCredit,
          notes: note.notes ?? null,
        },
        customer: {
          name: note.customerName,
          email: customer?.email ?? null,
          address: customer?.address ?? null,
        },
        invoiceNumber: note.invoiceNumber,
        lines: note.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });
  app.get("/api/customers/:id/credit-balance", (req, res) =>
    handle(res, () => noteService.customerCreditBalance(parseId(req.params.id)))
  );

  // ---------- Debit notes (AP) ----------
  app.post("/api/debit-notes", (req, res) =>
    handle(res, async () => {
      const data = createDebitNoteSchema.parse(req.body);
      return noteService.createDebitNote(data);
    })
  );
  app.get("/api/debit-notes", (req, res) =>
    handle(res, () =>
      noteService.listDebitNotes({
        vendorId: req.query.vendorId ? parseId(req.query.vendorId, "vendorId") : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        dateFrom: req.query.dateFrom ? parseDate(req.query.dateFrom, "dateFrom") : undefined,
        dateTo: req.query.dateTo ? parseDate(req.query.dateTo, "dateTo") : undefined,
      })
    )
  );
  app.get("/api/debit-notes/:id", (req, res) =>
    handle(res, async () => {
      const note = await noteService.getDebitNote(parseId(req.params.id));
      if (!note) throw new Error("Debit note not found");
      return note;
    })
  );
  app.post("/api/debit-notes/:id/apply", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = applyDebitNoteSchema.parse(req.body);
      return noteService.applyDebitNote(id, data.billId, data.amountToApply);
    })
  );
  app.post("/api/debit-notes/:id/unapply", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const applicationId = parseId(req.body?.applicationId, "applicationId");
      return noteService.unapplyDebitNote(id, applicationId);
    })
  );
  app.post("/api/debit-notes/:id/void", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = voidNoteSchema.parse(req.body);
      return noteService.voidDebitNote(id, data.reason);
    })
  );
  app.get("/api/debit-notes/:id/pdf", async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const note = await noteService.getDebitNote(id);
      if (!note) {
        res.status(404).json({ error: "Debit note not found" });
        return;
      }
      const vendor = await storage.getVendor(note.vendorId);
      streamDebitNotePdf(res, {
        note: {
          number: note.number,
          date: note.date,
          status: note.status,
          reason: note.reason,
          subtotal: note.subtotal,
          tax: note.tax,
          total: note.total,
          appliedAmount: note.appliedAmount,
          remainingDebit: note.remainingDebit,
          notes: note.notes ?? null,
        },
        vendor: {
          name: note.vendorName,
          email: vendor?.email ?? null,
          address: vendor?.address ?? null,
        },
        billNumber: note.billNumber,
        lines: note.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });
  app.get("/api/vendors/:id/debit-balance", (req, res) =>
    handle(res, () => noteService.vendorDebitBalance(parseId(req.params.id)))
  );

  // ---------- PDF downloads ----------
  app.get("/api/invoices/:id/pdf", async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const inv = await storage.getInvoice(id);
      if (!inv) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      const customer = inv.customer ?? { name: "Unknown", email: null, address: null };
      streamInvoicePdf(res, {
        invoice: {
          number: inv.number,
          date: inv.date,
          dueDate: inv.dueDate,
          subtotal: inv.subtotal,
          tax: inv.tax,
          total: inv.total,
          amountPaid: inv.amountPaid,
          status: inv.status,
          notes: inv.notes ?? null,
        },
        customer: { name: customer.name, email: customer.email ?? null, address: customer.address ?? null },
        lines: inv.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });

  app.get("/api/bills/:id/pdf", async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const bill = await storage.getBill(id);
      if (!bill) {
        res.status(404).json({ error: "Bill not found" });
        return;
      }
      const vendor = bill.vendor ?? { name: "Unknown", email: null, address: null };
      streamBillPdf(res, {
        bill: {
          number: bill.number,
          date: bill.date,
          dueDate: bill.dueDate,
          subtotal: bill.subtotal,
          tax: bill.tax,
          total: bill.total,
          amountPaid: bill.amountPaid,
          status: bill.status,
          notes: bill.notes ?? null,
        },
        vendor: { name: vendor.name, email: vendor.email ?? null, address: vendor.address ?? null },
        lines: bill.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });

  app.get("/api/reports/customer-statement.pdf", async (req, res) => {
    try {
      const customerId = parseId(req.query.customerId, "customerId");
      if (!customerId) throw new Error("customerId required");
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      const data = await storage.customerStatement(customerId, from, to);
      streamCustomerStatementPdf(res, {
        customer: {
          name: data.customer.name,
          email: data.customer.email ?? null,
          address: data.customer.address ?? null,
        },
        fromDate: data.fromDate,
        toDate: data.toDate,
        openingBalance: data.openingBalance,
        activity: data.activity,
        totalCharges: data.totalCharges,
        totalPayments: data.totalPayments,
        closingBalance: data.closingBalance,
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });

  app.get("/api/reports/vendor-statement.pdf", async (req, res) => {
    try {
      const vendorId = parseId(req.query.vendorId, "vendorId");
      if (!vendorId) throw new Error("vendorId required");
      const from = (req.query.from as string) || `${new Date().getFullYear()}-01-01`;
      const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
      const data = await storage.vendorStatement(vendorId, from, to);
      streamVendorStatementPdf(res, {
        vendor: {
          name: data.vendor.name,
          email: data.vendor.email ?? null,
          address: data.vendor.address ?? null,
        },
        fromDate: data.fromDate,
        toDate: data.toDate,
        openingBalance: data.openingBalance,
        activity: data.activity,
        totalCharges: data.totalCharges,
        totalPayments: data.totalPayments,
        closingBalance: data.closingBalance,
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });

  // ---------- Bank Transactions ----------
  app.get("/api/bank-transactions", (req, res) =>
    handle(res, async () => {
      const bankAccountId = req.query.bankAccountId ? Number(req.query.bankAccountId) : undefined;
      const status = req.query.status as string | undefined;
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      return storage.listBankTransactions(bankAccountId, status, limit, offset);
    })
  );
  app.post("/api/bank-transactions/manual", (req, res) =>
    handle(res, async () => {
      const data = postBankTransactionSchema.parse(req.body);
      return storage.postManualBankTransaction(data);
    })
  );
  // Bulk import is the heaviest write in the system — its own 10/min budget
  // (Task 6) on top of the blanket write limiter.
  app.post("/api/bank-transactions/import", importLimiter, (req, res) =>
    handle(res, async () => {
      const data = importBankTransactionsSchema.parse(req.body);
      return storage.importBankTransactions(data);
    })
  );
  app.get("/api/bank-transactions/:id/suggestions", (req, res) =>
    handle(res, () => storage.suggestMatches(parseId(req.params.id)))
  );
  app.post("/api/bank-transactions/:id/match", (req, res) =>
    handle(res, async () => {
      const data = matchBankTransactionSchema.parse({
        ...req.body,
        bankTransactionId: parseId(req.params.id),
      });
      return storage.matchBankTransaction(data);
    })
  );
  // Task 4: undo a match/ignore — deletes the match's JE, restores any
  // invoice/bill payment it recorded, returns the row to "unmatched".
  app.post("/api/bank-transactions/:id/unmatch", (req, res) =>
    handle(res, () => storage.unmatchBankTransaction(parseId(req.params.id)))
  );

  // ---------- Plaid (scaffolding) ----------
  app.get("/api/plaid/status", (_req, res) => res.json(plaidStatus()));

  // Step 1: get a link token for Plaid Link UI
  app.post("/api/plaid/link-token", async (req, res) => {
    try {
      const userId = String(req.user?.id ?? "default-user");
      const out = await createLinkToken(userId);
      if ("error" in out) return res.status(503).json(out);
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Step 2: exchange the public_token Plaid Link returns for a permanent access_token,
  // and persist it linked to a bank account in our chart of accounts.
  app.post("/api/plaid/exchange", async (req, res) => {
    try {
      const publicToken = req.body?.public_token as string;
      const bankAccountId = Number(req.body?.bankAccountId);
      const institutionName = req.body?.institutionName as string | undefined;
      if (!publicToken) return res.status(400).json({ error: "public_token required" });
      if (!Number.isInteger(bankAccountId) || bankAccountId <= 0) {
        return res.status(400).json({ error: "bankAccountId required (integer)" });
      }
      // Validate the bank account exists and is bank-subtype
      const acct = await storage.getAccount(bankAccountId);
      if (!acct) return res.status(400).json({ error: "Bank account not found" });
      if (acct.subtype !== "bank") {
        return res.status(400).json({ error: `Account "${acct.name}" must be a bank-subtype asset` });
      }
      const out = await exchangePublicToken(publicToken);
      if ("error" in out) return res.status(503).json(out);
      const item = await storage.savePlaidItem({
        bankAccountId,
        accessToken: out.access_token,
        itemId: out.item_id,
        institutionName,
      });
      res.json({ ok: true, plaidItemId: item.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // List connected items (without leaking access tokens)
  app.get("/api/plaid/items", (_req, res) => handle(res, () => storage.listPlaidItems()));

  // Disconnect a Plaid item
  app.delete("/api/plaid/items/:id", (req, res) =>
    handle(res, async () => {
      await storage.deletePlaidItem(parseId(req.params.id));
      return { ok: true };
    })
  );

  // Step 3: sync transactions for a stored item.
  // Loops until has_more is false, importing every batch via storage.importBankTransactions.
  app.post("/api/plaid/items/:id/sync", async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const item = await storage.getPlaidItemAccessToken(id);
      if (!item) return res.status(404).json({ error: "Plaid item not found" });

      let cursor = item.cursor || undefined;
      let totalAdded = 0, totalSkipped = 0, totalAutoMatched = 0;
      const errors: string[] = [];
      // Up to 10 pages per request to bound runtime — caller can re-trigger if needed
      for (let page = 0; page < 10; page++) {
        const out = await syncTransactions(item.accessToken, cursor);
        if ("error" in out) {
          await storage.updatePlaidItemCursor(id, cursor || "", out.error);
          return res.status(503).json({ error: out.error });
        }
        if (out.added.length > 0) {
          const r = await storage.importBankTransactions({
            bankAccountId: item.bankAccountId,
            source: "plaid",
            transactions: out.added,
          });
          totalAdded += r.inserted;
          totalSkipped += r.skipped;
          totalAutoMatched += r.autoMatched;
          if (r.ruleErrors?.length) errors.push(...r.ruleErrors);
        }
        cursor = out.next_cursor;
        if (!out.has_more) break;
      }
      await storage.updatePlaidItemCursor(id, cursor || "");
      res.json({ added: totalAdded, skipped: totalSkipped, autoMatched: totalAutoMatched, errors });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Plaid webhook (no auth — Plaid signs the body; we'd verify with their key in prod).
  // For now we just log and ack so Plaid stops retrying.
  app.post("/api/plaid/webhook", async (req, res) => {
    try {
      const result = handlePlaidWebhook(req.body);
      res.json(result);
    } catch (e: any) {
      logger.error("[plaid/webhook] processing error", { error: e?.message, stack: e?.stack?.split("\n").slice(0, 5).join(" | ") });
      res.status(200).json({ ok: false }); // don't 500 — Plaid will retry forever
    }
  });

  // ---------- Sales tax: TaxJar status / preview / nexus ----------
  // configured + sandbox flags and how many states the org has nexus in.
  app.get("/api/tax/status", (_req, res) =>
    handle(res, async () => {
      const st = taxjarStatus();
      return { ...st, nexusCount: (await storage.listNexusStates()).length };
    })
  );

  // Preview a tax calculation without saving anything (e.g. before creating an
  // invoice). amount is INTEGER CENTS. Applies the same nexus gate + fallback
  // behavior as real invoice creation.
  const taxCalculateSchema = z.object({
    toZip: z.string().regex(/^\d{5}(-\d{4})?$/, "Use a 5-digit ZIP (or ZIP+4)"),
    toState: z.string().regex(/^[A-Za-z]{2}$/, "Use a 2-letter state code, e.g. TX"),
    toCity: z.string().max(120).optional(),
    amount: z.number().int().nonnegative().max(1_000_000_000), // cents
    productTaxCode: z.string().max(30).optional(),
    taxCodeId: z.number().int().positive().optional(), // manual fallback selector
  });
  app.post("/api/tax/calculate", (req, res) =>
    handleAsync(res, async () => {
      const data = taxCalculateSchema.parse(req.body);
      const ctx = await storage.taxCalculationContext(data.taxCodeId);
      if (!ctx.fromZip || !ctx.fromState) {
        throw new Error(
          "Organization ship-from address is missing — set address ZIP/state on the organization first"
        );
      }
      const calc = await calculateSalesTax({
        fromZip: ctx.fromZip,
        fromState: ctx.fromState,
        fromCity: ctx.fromCity,
        toZip: data.toZip,
        toState: data.toState,
        toCity: data.toCity,
        amount: data.amount,
        productTaxCode: data.productTaxCode,
        nexusStates: ctx.nexusStates,
        fallback: ctx.fallback,
      });
      // Preview response: everything except the raw payload (which is stored on
      // real invoices for audit; for previews it just bloats the response).
      const { raw, ...preview } = calc;
      return preview;
    })
  );

  // Address validation passthrough (returns valid:false gracefully when TaxJar
  // is unconfigured).
  app.post("/api/tax/validate-address", (req, res) =>
    handleAsync(res, async () => {
      const schema = z.object({
        street: z.string().max(200).optional(),
        city: z.string().max(120).optional(),
        state: z.string().regex(/^[A-Za-z]{2}$/).optional(),
        zip: z.string().regex(/^\d{5}(-\d{4})?$/).optional(),
      });
      return validateAddress(schema.parse(req.body));
    })
  );

  // Nexus states — where the org has a sales-tax obligation. Mutations are
  // owner/admin only: registering/deregistering nexus is a compliance decision.
  app.get("/api/tax/nexus", (_req, res) => handle(res, () => storage.listNexusStates()));
  app.post("/api/tax/nexus", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const data = nexusStateSchema.parse(req.body);
      return storage.addNexusState(data);
    })
  );
  app.delete("/api/tax/nexus/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      await storage.deleteNexusState(parseId(req.params.id));
      return { ok: true };
    })
  );

  // ---------- Bank Rules ----------
  app.get("/api/bank-rules", (_req, res) => handle(res, () => storage.listBankRules()));
  app.post("/api/bank-rules", (req, res) =>
    handle(res, async () => {
      const data = bankRuleSchema.parse(req.body);
      return storage.createBankRule(data);
    })
  );
  app.patch("/api/bank-rules/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = bankRuleUpdateSchema.parse(req.body);
      return storage.updateBankRule(id, data);
    })
  );
  app.delete("/api/bank-rules/:id", (req, res) =>
    handle(res, async () => {
      await storage.deleteBankRule(parseId(req.params.id));
      return { ok: true };
    })
  );
  app.post("/api/bank-rules/apply", (req, res) =>
    handle(res, async () => {
      const bankAccountId = req.body?.bankAccountId ? Number(req.body.bankAccountId) : undefined;
      const matched = await storage.applyRulesToUnmatched(bankAccountId);
      return { autoMatched: matched };
    })
  );

  // ---------- Reconciliation ----------
  app.get("/api/reconciliations", (req, res) =>
    handle(res, async () => {
      const bankAccountId = req.query.bankAccountId ? Number(req.query.bankAccountId) : undefined;
      return storage.listReconciliations(bankAccountId);
    })
  );
  app.get("/api/reconciliations/:id", (req, res) =>
    handle(res, () => storage.getReconciliation(parseId(req.params.id)))
  );
  app.post("/api/reconciliations", (req, res) =>
    handle(res, async () => {
      const data = startReconciliationSchema.parse(req.body);
      return storage.startReconciliation(data);
    })
  );
  app.post("/api/reconciliations/:id/toggle", (req, res) =>
    handle(res, async () => {
      const data = toggleReconItemSchema.parse(req.body);
      return storage.toggleReconItem(parseId(req.params.id), data.bankTransactionId, data.cleared);
    })
  );
  app.post("/api/reconciliations/:id/complete", (req, res) =>
    handle(res, () => storage.completeReconciliation(parseId(req.params.id)))
  );
  // Task 5: abandon an in-progress reconciliation. Completed reconciliations
  // are immutable history and cannot be deleted (enforced in storage).
  app.delete("/api/reconciliations/:id", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, () => storage.deleteReconciliation(parseId(req.params.id)))
  );

  // ---------- Recurring Transactions ----------
  app.get("/api/recurring", (_req, res) => handle(res, () => storage.listRecurring()));
  app.post("/api/recurring", (req, res) =>
    handle(res, async () => {
      const data = createRecurringSchema.parse(req.body);
      return storage.createRecurring(data);
    })
  );
  app.patch("/api/recurring/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = updateRecurringSchema.parse(req.body);
      return storage.updateRecurring(id, data);
    })
  );
  app.delete("/api/recurring/:id", (req, res) =>
    handle(res, async () => {
      await storage.deleteRecurring(parseId(req.params.id));
      return { ok: true };
    })
  );
  app.post("/api/recurring/:id/run", (req, res) =>
    handle(res, () => storage.runRecurringOnce(parseId(req.params.id)))
  );
  app.post("/api/recurring/run-catchup", (_req, res) =>
    handle(res, () => storage.runCatchUp())
  );

  // ---------- Batch Reclassify ----------
  app.post("/api/reclassify", (req, res) =>
    handle(res, async () => {
      const data = reclassifySchema.parse(req.body);
      return storage.reclassifyLines(data);
    })
  );

  // ---------- Dashboard ----------
  app.get("/api/dashboard", (_req, res) => handle(res, () => storage.dashboardStats()));

  // ============================================================================
  // Sprint C: Sales Tax Codes
  // ============================================================================
  app.get("/api/tax-codes", (_req, res) => handle(res, () => storage.listTaxCodes()));
  app.post("/api/tax-codes", (req, res) =>
    handle(res, async () => {
      const data = taxCodeSchema.parse(req.body);
      return storage.createTaxCode(data);
    })
  );
  app.patch("/api/tax-codes/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const data = taxCodeSchema.partial().parse(req.body);
      return storage.updateTaxCode(id, data);
    })
  );
  app.delete("/api/tax-codes/:id", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      return storage.deleteTaxCode(id);
    })
  );
  app.get("/api/reports/tax-liability", (req, res) =>
    handle(res, () => storage.taxLiabilityReport((req.query.asOf as string) || undefined))
  );

  // 1099 Summary — cash paid to 1099-tracked vendors in a calendar year.
  // ?year=YYYY (default: current year), ?threshold=<dollars> (default 600).
  app.get("/api/reports/1099-summary", (req, res) =>
    handle(res, () => {
      const { year, threshold } = z
        .object({
          year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
          threshold: z.coerce.number().min(0).default(600),
        })
        .parse(req.query);
      return storage.report1099Summary(year, Math.round(threshold * 100));
    })
  );

  // ============================================================================
  // Sprint C: Period Close / Year-End Close
  // ============================================================================
  app.get("/api/period-locks", (_req, res) => handle(res, () => storage.listPeriodLocks()));
  // Period close — mounted at POST /api/period-locks (the "close" action).
  // Closing periods is an owner/admin-only compliance action.
  app.post("/api/period-locks", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const data = closePeriodSchema.parse(req.body);
      return storage.closePeriod(data);
    })
  );
  // Reopen — mounted at DELETE /api/period-locks/:id (the "reopen" action).
  app.delete("/api/period-locks/:id", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      return storage.reopenPeriod(id);
    })
  );
  app.post("/api/period-locks/year-end-close", requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const data = yearEndCloseSchema.parse(req.body);
      return storage.yearEndClose(data);
    })
  );

  // ============================================================================
  // Sprint C: Audit Log
  // ============================================================================
  // Audit log: owner/admin/accountant only (viewers have no business reading
  // the change history). Filters: entityType, action, from, to, userId,
  // entityId, q (free-text on summary). ?format=csv exports the CURRENT view.
  app.get("/api/audit", requireRole("owner", "admin", "accountant"), (req, res) =>
    handle(res, async () => {
      const { limit, offset } = paginationQuerySchema.parse(req.query);
      const opts = {
        limit,
        offset,
        entityType: (req.query.entityType as string) || undefined,
        action: (req.query.action as string) || undefined,
        from: (req.query.from as string) || undefined,
        to: (req.query.to as string) || undefined,
        userId: (req.query.userId as string) || undefined,
        entityId: req.query.entityId ? parseId(String(req.query.entityId)) : undefined,
        q: (req.query.q as string) || undefined,
      };
      const page = await storage.listAuditLog(opts);
      if (String(req.query.format || "") === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="audit-log.csv"`);
        res.send(toCsv(page.rows as any[], [
          { key: "id", header: "ID" },
          { key: "ts", header: "Timestamp" },
          { key: "user", header: "User" },
          { key: "action", header: "Action" },
          { key: "entityType", header: "Entity Type" },
          { key: "entityId", header: "Entity ID" },
          { key: "summary", header: "Summary" },
        ]));
        return undefined as any;
      }
      return page;
    })
  );

  // ============================================================================
  // Sprint C: Global Search (Cmd-K)
  // ============================================================================
  app.get("/api/search", (req, res) =>
    handle(res, async () => {
      const q = (req.query.q as string) || "";
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      if (!q.trim()) return [];
      return storage.globalSearch(q, limit);
    })
  );

  // ============================================================================
  // Sprint C: Email status
  // ============================================================================
  app.get("/api/email/status", (_req, res) => handle(res, () => smtpStatus()));

  // ============================================================================
  // Sprint C: Invoice Sharing — create share link, send via email
  // ============================================================================
  app.get("/api/invoices/:id/shares", (req, res) =>
    handle(res, () => storage.listSharesForInvoice(parseId(req.params.id)))
  );

  app.post("/api/invoices/:id/share", (req, res) =>
    handle(res, async () => {
      const id = parseId(req.params.id);
      const inv = await storage.getInvoice(id);
      if (!inv) throw new Error("Invoice not found");
      const recipient = (req.body?.email as string | undefined) || inv.customer?.email || undefined;
      const expiresInDays = req.body?.expiresInDays ? Number(req.body.expiresInDays) : 90;
      const share = await storage.createInvoiceShare(id, recipient, expiresInDays);
      const url = `${appBaseUrl()}/p/invoice/${share.token}`;
      return { share, url };
    })
  );

  app.post("/api/invoices/shares/:shareId/revoke", (req, res) =>
    handle(res, () => storage.revokeInvoiceShare(parseId(req.params.shareId, "shareId")))
  );

  app.post("/api/invoices/:id/send", async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const body = sendInvoiceSchema.parse({ ...req.body, invoiceId: id });
      const inv = await storage.getInvoice(id);
      if (!inv) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      const to = body.to || inv.customer?.email;
      if (!to) {
        res.status(400).json({ error: "No recipient email — pass `to` or set customer email" });
        return;
      }
      const share = await storage.createInvoiceShare(id, to);
      const url = `${appBaseUrl()}/p/invoice/${share.token}`;
      const subject = body.subject || `Invoice ${inv.number} from LedgerLite`;
      const customerName = inv.customer?.name || "there";
      const text =
        body.body ||
        [
          `Hi ${customerName},`,
          ``,
          `Please find your invoice ${inv.number} attached / linked below.`,
          ``,
          `  Amount due: ${formatMoney(inv.total - (inv.amountPaid || 0))}`,
          `  Due date:   ${inv.dueDate}`,
          ``,
          `View invoice online: ${url}`,
          `Download PDF:        ${url}/pdf`,
          ``,
          `Thank you for your business,`,
          `LedgerLite`,
        ].join("\n");
      const html = `<p>Hi ${customerName},</p>
<p>Please find your invoice <strong>${inv.number}</strong> below.</p>
<ul>
  <li>Amount due: <strong>${formatMoney(inv.total - (inv.amountPaid || 0))}</strong></li>
  <li>Due date: ${inv.dueDate}</li>
</ul>
<p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#0f766e;color:#fff;text-decoration:none;border-radius:6px;">View invoice</a> &nbsp; <a href="${url}/pdf">Download PDF</a></p>
<p>Thanks,<br/>LedgerLite</p>`;
      const sendResult = await sendEmail({ to, cc: body.cc, subject, text, html });
      await storage.markShareSent(
        share.id,
        sendResult.ok ? "sent" : "failed",
        sendResult.ok ? undefined : sendResult.error
      );
      await storage.audit("send", "invoice", id, `Sent invoice ${inv.number} to ${to}`, {
        shareId: share.id,
        mode: sendResult.mode,
      });
      res.json({ share, url, sendResult });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Validation failed", details: err.errors });
      } else {
        logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
        res.status(500).json({ error: err.message || "Server error" });
      }
    }
  });

  // ============================================================================
  // Sprint C: Public Invoice View (no auth — token-based)
  // ============================================================================
  app.get("/p/estimate/:token", publicLimiter, async (req, res) => {
    try {
      const token = req.params.token;
      const data = await storage.getEstimateShareByToken(token);
      if (!data || !data.estimate) {
        res.status(404).type("html").send("<h1>Estimate not found</h1><p>This share link is invalid or has been revoked.</p>");
        return;
      }
      await storage.recordEstimateShareView(token);
      const est = data.estimate;
      const cust = data.customer || { name: "Customer" };
      const lines = (data.lines || []) as any[];
      const fmtMoney = (n: number) =>
        `$${Number((n || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const fmtRate = (n: number) =>
        `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const expired = est.status === "expired" || (est.expiryDate && est.expiryDate < new Date().toISOString().slice(0, 10) && est.status !== "invoiced");
      const statusColor = est.status === "invoiced" ? "#15803d" : expired ? "#b91c1c" : "#0f766e";
      const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Estimate ${escapeHtml(est.number)} — LedgerLite</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;}
  .wrap{max-width:780px;margin:40px auto;padding:0 20px;}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,.04);}
  .head{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;margin-bottom:32px;border-bottom:1px solid #e2e8f0;padding-bottom:24px;}
  .brand{font-weight:700;font-size:22px;letter-spacing:-0.02em;}
  .brand small{display:block;font-weight:400;color:#64748b;font-size:12px;margin-top:4px;}
  .num{text-align:right;}
  .num .label{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;}
  .num .val{font-size:20px;font-weight:600;}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#fff;background:${statusColor};margin-top:6px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px;}
  .grid h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:600;}
  .grid p{margin:0;line-height:1.5;}
  table{width:100%;border-collapse:collapse;margin-bottom:24px;}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #e2e8f0;padding:10px 8px;font-weight:600;}
  td{padding:12px 8px;border-bottom:1px solid #f1f5f9;}
  td.r,th.r{text-align:right;}
  .totals{margin-left:auto;width:280px;}
  .totals .row{display:flex;justify-content:space-between;padding:6px 0;}
  .totals .total{border-top:2px solid #0f172a;margin-top:6px;padding-top:10px;font-weight:700;font-size:18px;}
  .notes{margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:14px;color:#475569;}
  .footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px;}
</style></head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div><div class="brand">LedgerLite <small>Modern small-business accounting</small></div></div>
        <div class="num">
          <div class="label">Estimate</div>
          <div class="val">${escapeHtml(est.number)}</div>
          <span class="pill">${escapeHtml(est.status || "draft")}</span>
        </div>
      </div>
      <div class="grid">
        <div>
          <h4>Prepared for</h4>
          <p><strong>${escapeHtml(cust.name || "Customer")}</strong>${cust.email ? `<br/>${escapeHtml(cust.email)}` : ""}${cust.address ? `<br/>${escapeHtml(cust.address).replace(/\n/g, "<br/>")}` : ""}</p>
        </div>
        <div>
          <h4>Dates</h4>
          <p>Issued: <strong>${escapeHtml(est.date)}</strong><br/>Valid until: <strong>${escapeHtml(est.expiryDate)}</strong></p>
        </div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>
          ${lines
            .map((l: any) => `<tr><td>${escapeHtml(l.description || "")}</td><td class="r">${escapeHtml(l.quantity)}</td><td class="r">${fmtRate(l.rate)}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`)
            .join("")}
        </tbody>
      </table>
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>${fmtMoney(est.subtotalCents)}</span></div>
        <div class="row"><span>Tax</span><span>${fmtMoney(est.taxCents)}</span></div>
        <div class="row total"><span>Total</span><span>${fmtMoney(est.totalCents)}</span></div>
      </div>
      ${est.notes ? `<div class="notes">${escapeHtml(est.notes).replace(/\n/g, "<br/>")}</div>` : ""}
    </div>
    <div class="footer">Powered by LedgerLite · This is a read-only quote shared with ${escapeHtml(cust.email || "you")}</div>
  </div>
</body></html>`;
      res.type("html").send(html);
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).type("html").send("<h1>Server error</h1>");
    }
  });

  app.get("/p/invoice/:token", publicLimiter, async (req, res) => {
    try {
      const token = req.params.token;
      const data = await storage.getShareByToken(token);
      if (!data || !data.invoice) {
        res.status(404).type("html").send("<h1>Invoice not found</h1><p>This share link is invalid or has been revoked.</p>");
        return;
      }
      await storage.recordShareView(token);
      const inv = data.invoice;
      const cust = data.customer || { name: "Customer" };
      const lines = (data.lines || []) as any[];
      const fmtMoney = (n: number) =>
        `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const balance = (inv.total || 0) - (inv.amountPaid || 0);
      const statusColor =
        inv.status === "paid" ? "#15803d" : balance > 0 && new Date(inv.dueDate) < new Date() ? "#b91c1c" : "#0f766e";
      const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Invoice ${escapeHtml(inv.number)} — LedgerLite</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;}
  .wrap{max-width:780px;margin:40px auto;padding:0 20px;}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,.04);}
  .head{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;margin-bottom:32px;border-bottom:1px solid #e2e8f0;padding-bottom:24px;}
  .brand{font-weight:700;font-size:22px;letter-spacing:-0.02em;}
  .brand small{display:block;font-weight:400;color:#64748b;font-size:12px;margin-top:4px;}
  .num{text-align:right;}
  .num .label{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;}
  .num .val{font-size:20px;font-weight:600;}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#fff;background:${statusColor};margin-top:6px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px;}
  .grid h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:600;}
  .grid p{margin:0;line-height:1.5;}
  table{width:100%;border-collapse:collapse;margin-bottom:24px;}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #e2e8f0;padding:10px 8px;font-weight:600;}
  td{padding:12px 8px;border-bottom:1px solid #f1f5f9;}
  td.r,th.r{text-align:right;}
  .totals{margin-left:auto;width:280px;}
  .totals .row{display:flex;justify-content:space-between;padding:6px 0;}
  .totals .total{border-top:2px solid #0f172a;margin-top:6px;padding-top:10px;font-weight:700;font-size:18px;}
  .actions{display:flex;gap:12px;margin-top:28px;}
  .btn{display:inline-block;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;}
  .btn-primary{background:#0f172a;color:#fff;}
  .btn-secondary{background:#f1f5f9;color:#0f172a;border:1px solid #e2e8f0;}
  .notes{margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:14px;color:#475569;}
  .footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px;}
</style></head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div>
          <div class="brand">LedgerLite <small>Modern small-business accounting</small></div>
        </div>
        <div class="num">
          <div class="label">Invoice</div>
          <div class="val">${escapeHtml(inv.number)}</div>
          <span class="pill">${escapeHtml(inv.status || "open")}</span>
        </div>
      </div>
      <div class="grid">
        <div>
          <h4>Bill to</h4>
          <p><strong>${escapeHtml(cust.name || "Customer")}</strong>${cust.email ? `<br/>${escapeHtml(cust.email)}` : ""}${cust.address ? `<br/>${escapeHtml(cust.address).replace(/\n/g, "<br/>")}` : ""}</p>
        </div>
        <div>
          <h4>Dates</h4>
          <p>Issue date: <strong>${escapeHtml(inv.date)}</strong><br/>Due date: <strong>${escapeHtml(inv.dueDate)}</strong></p>
        </div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>
          ${lines
            .map(
              (l: any) =>
                `<tr><td>${escapeHtml(l.description || "")}</td><td class="r">${escapeHtml(l.quantity)}</td><td class="r">${fmtMoney(l.rate)}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>${fmtMoney(inv.subtotal)}</span></div>
        <div class="row"><span>Tax</span><span>${fmtMoney(inv.tax)}</span></div>
        <div class="row"><span>Total</span><span>${fmtMoney(inv.total)}</span></div>
        <div class="row"><span>Paid</span><span>${fmtMoney(inv.amountPaid || 0)}</span></div>
        <div class="row total"><span>Balance due</span><span>${fmtMoney(balance)}</span></div>
      </div>
      ${inv.notes ? `<div class="notes">${escapeHtml(inv.notes).replace(/\n/g, "<br/>")}</div>` : ""}
      <div class="actions">
        <a class="btn btn-primary" href="/p/invoice/${encodeURIComponent(token)}/pdf">Download PDF</a>
        <!-- Print button removed (Task 3): its javascript:window.print() href
             violates CSP script-src. Recipients can print from the PDF. -->
      </div>
    </div>
    <div class="footer">Powered by LedgerLite · This is a read-only preview shared with ${escapeHtml(cust.email || "you")}</div>
  </div>
</body></html>`;
      res.type("html").send(html);
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).type("html").send("<h1>Server error</h1>");
    }
  });

  app.get("/p/invoice/:token/pdf", publicLimiter, async (req, res) => {
    try {
      const token = req.params.token;
      const data = await storage.getShareByToken(token);
      if (!data || !data.invoice) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      await storage.recordShareView(token);
      const inv = data.invoice;
      const customer = data.customer ?? { name: "Customer", email: null, address: null };
      const lines = (data.lines || []) as any[];
      streamInvoicePdf(res, {
        invoice: {
          number: inv.number,
          date: inv.date,
          dueDate: inv.dueDate,
          subtotal: inv.subtotal,
          tax: inv.tax,
          total: inv.total,
          amountPaid: inv.amountPaid,
          status: inv.status,
          notes: inv.notes ?? null,
        },
        customer: { name: customer.name, email: customer.email ?? null, address: customer.address ?? null },
        lines: lines.map((l: any) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      });
    } catch (err: any) {
      logger.error("Route error", { reqId: (res.req as any)?.reqId, error: err?.message });
      res.status(500).json({ error: err.message || "PDF generation failed" });
    }
  });

  // ---------- Demo seed (for dev convenience) ----------
  app.post("/api/seed-demo", requireRole("owner", "admin"), (req, res) => {
    // Production guard: demo data must never land in a live tenant's books.
    // Checked BEFORE handle() so we send exactly one response.
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Not available in production" });
    }
    return handle(res, async () => {
      // Customers — force past duplicate-name detection so the dev seed stays
      // re-runnable (BUG-006).
      const c1 = await storage.createCustomer({ name: "Acme Corp", email: "ap@acme.com", phone: "555-0100", address: undefined, notes: undefined }, { force: true });
      const c2 = await storage.createCustomer({ name: "Globex LLC", email: "billing@globex.com", phone: "555-0200", address: undefined, notes: undefined }, { force: true });
      const c3 = await storage.createCustomer({ name: "Initech Inc", email: "accounts@initech.com", phone: undefined, address: undefined, notes: undefined }, { force: true });
      // Vendors
      const v1 = await storage.createVendor({ name: "WeWork", email: "billing@wework.com", phone: undefined, address: undefined, notes: undefined }, { force: true });
      const v2 = await storage.createVendor({ name: "AWS", email: "billing@aws.com", phone: undefined, address: undefined, notes: undefined }, { force: true });
      const v3 = await storage.createVendor({ name: "Office Depot", email: undefined, phone: undefined, address: undefined, notes: undefined }, { force: true });

      const accts = await storage.listAccounts();
      const byCode = (code: string) => accts.find((a) => a.code === code)!;
      const checking = byCode("1000");
      const salesTaxLiab = byCode("2100");
      // Sprint C: seed a tax code if none exists
      const existingCodes = await storage.listTaxCodes();
      if (existingCodes.length === 0 && salesTaxLiab) {
        await storage.createTaxCode({
          name: "NY State 8.875%",
          rate: 8.875,
          agency: "NY Dept of Taxation & Finance",
          liabilityAccountId: salesTaxLiab.id,
          isActive: true,
        });
      }
      const salesRev = byCode("4000");
      const serviceRev = byCode("4100");
      const rent = byCode("6000");
      const software = byCode("6500");
      const supplies = byCode("6200");
      const equity = byCode("3000");

      // Initial capital deposit
      await storage.postJournalEntry({
        date: "2026-01-01",
        memo: "Owner initial investment",
        reference: "DEPOSIT",
        source: "manual",
        lines: [
          { accountId: checking.id, debit: 25000, credit: 0 },
          { accountId: equity.id, debit: 0, credit: 25000 },
        ],
      });

      // Invoices
      const inv1 = await storage.createInvoice({
        number: "INV-1001",
        customerId: c1.id,
        date: "2026-02-05",
        dueDate: "2026-03-07",
        taxRate: 8.25,
        notes: undefined,
        lines: [
          { description: "Consulting services - Feb", quantity: 40, rate: 150, incomeAccountId: serviceRev.id },
        ],
      });
      const inv2 = await storage.createInvoice({
        number: "INV-1002",
        customerId: c2.id,
        date: "2026-03-10",
        dueDate: "2026-04-09",
        taxRate: 8.25,
        notes: undefined,
        lines: [
          { description: "Software license", quantity: 10, rate: 99, incomeAccountId: salesRev.id },
          { description: "Implementation", quantity: 5, rate: 200, incomeAccountId: serviceRev.id },
        ],
      });
      const inv3 = await storage.createInvoice({
        number: "INV-1003",
        customerId: c3.id,
        date: "2026-03-25",
        dueDate: "2026-04-24",
        taxRate: 0,
        notes: undefined,
        lines: [
          { description: "Maintenance retainer", quantity: 1, rate: 1500, incomeAccountId: serviceRev.id },
        ],
      });

      // Pay first invoice in full — payInvoice expects DOLLARS at the boundary
      // (it calls toCents internally); inv1.total is integer cents.
      await storage.payInvoice({
        invoiceId: inv1.id,
        date: "2026-02-28",
        amount: inv1.total / 100,
        bankAccountId: checking.id,
        memo: "Acme payment",
      });
      // Partial payment on inv2
      await storage.payInvoice({
        invoiceId: inv2.id,
        date: "2026-03-30",
        amount: 500,
        bankAccountId: checking.id,
        memo: "Globex partial",
      });

      // Bills
      const b1 = await storage.createBill({
        number: "BILL-501",
        vendorId: v1.id,
        date: "2026-02-01",
        dueDate: "2026-02-15",
        taxRate: 0,
        notes: undefined,
        lines: [{ description: "Office rent - Feb", quantity: 1, rate: 2500, expenseAccountId: rent.id }],
      });
      const b2 = await storage.createBill({
        number: "BILL-502",
        vendorId: v2.id,
        date: "2026-03-01",
        dueDate: "2026-03-31",
        taxRate: 0,
        notes: undefined,
        lines: [{ description: "AWS hosting - March", quantity: 1, rate: 480, expenseAccountId: software.id }],
      });
      const b3 = await storage.createBill({
        number: "BILL-503",
        vendorId: v3.id,
        date: "2026-03-12",
        dueDate: "2026-04-12",
        taxRate: 8.25,
        notes: undefined,
        lines: [{ description: "Office supplies", quantity: 1, rate: 320, expenseAccountId: supplies.id }],
      });

      // Pay bill 1 — same dollars-at-the-boundary contract as payInvoice.
      await storage.payBill({
        billId: b1.id,
        date: "2026-02-10",
        amount: b1.total / 100,
        bankAccountId: checking.id,
        memo: "Rent payment",
      });

      return { ok: true, message: "Demo data seeded" };
    });
  });

  return httpServer;
}
