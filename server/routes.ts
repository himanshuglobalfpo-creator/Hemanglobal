/**
 * server/routes.ts — HTTP API.
 * Every business route is behind requireAuth + enforceOwnerMfa (TASK 2 gate).
 * Webhook events are emitted AFTER storage transactions return (i.e. after
 * commit) — never inside them.
 */
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction, Router } from "express";
import bcrypt from "bcryptjs";
import { ZodError } from "zod";
import { db } from "./db.js";
import * as storage from "./storage.js";
import { HttpError } from "./storage.js";
import {
  registerSchema, loginSchema, insertCustomerSchema, insertVendorSchema, insertAccountSchema,
  mfaEnableSchema, mfaDisableSchema, mfaVerifySchema, fxRatesPutSchema, insertBudgetSchema,
  putBudgetLinesSchema, insertWebhookSchema, insertCreditNoteSchema, auditQuerySchema,
  reportRangeSchema, budgetVsActualQuerySchema, openingBalanceMetaSchema, isoDate,
  ATTACHMENT_ENTITY_TYPES, ATTACHMENT_MIME_WHITELIST, ATTACHMENT_MAX_BYTES, WEBHOOK_EVENTS,
} from "../shared/schema.js";
import {
  requireAuth, requireRole, enforceOwnerMfa, createSession, destroySession,
  setSessionCookie, SESSION_COOKIE, type AuthContext,
} from "./auth.js";
import { generateTotpSecret, verifyTotp, otpauthUri, generateRecoveryCodes } from "./totp.js";
import { vaultEncrypt, vaultDecrypt } from "./vault.js";
import { emitEvent, assertUrlIsPublic, runDeliveryPass } from "./webhooks.js";
import { fileDriver, newStorageKey } from "./files.js";
import { sendCsv, type CsvColumn } from "./csv.js";
import * as importers from "./importers.js";
import { invoiceDocumentHtml, customerStatementHtml } from "./documents.js";

const ctx = (req: Request): AuthContext => req.ctx as AuthContext;

/** Wraps async/throwing handlers into express error flow. */
const h = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

export function buildRouter(): Router {
  const router = Router();
  router.use(express.json({ limit: "2mb" }));

  /* ================================================================ */
  /* Auth                                                             */
  /* ================================================================ */

  // Brute-force guard on password login: 10 FAILED attempts per 5 minutes
  // per (ip, email) bucket. In-memory is fine for a single-node deployment;
  // successful logins never count against the bucket.
  const LOGIN_WINDOW_MS = 5 * 60_000;
  const LOGIN_MAX_FAILURES = 10;
  const loginFailures = new Map<string, number[]>();
  const loginKey = (req: Request): string =>
    `${req.ip ?? "?"}|${String((req.body as Record<string, unknown> | undefined)?.email ?? "").toLowerCase()}`;

  const recordLoginFailure = (req: Request): void => {
    const key = loginKey(req);
    const now = Date.now();
    const hits = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    hits.push(now);
    loginFailures.set(key, hits);
    if (loginFailures.size > 10_000) {
      // bound the map: drop buckets whose newest failure has aged out
      for (const [k, v] of loginFailures) if (now - (v[v.length - 1] ?? 0) >= LOGIN_WINDOW_MS) loginFailures.delete(k);
    }
  };

  const loginRateLimit = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const hits = (loginFailures.get(loginKey(req)) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (hits.length >= LOGIN_MAX_FAILURES) {
      res.status(429).json({ error: "too many failed login attempts; try again later", code: "RATE_LIMITED" });
      return;
    }
    next();
  };

  router.post("/api/auth/register", h(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const existing = db.prepare("SELECT 1 FROM users WHERE email = ?").get(input.email.toLowerCase());
    if (existing) throw new HttpError(409, "email already registered");
    // bcrypt work happens async BEFORE the (synchronous) transaction so the
    // event loop is never blocked and no await sits inside the tx.
    const passwordHash = await bcrypt.hash(input.password, 10);
    const run = db.transaction(() => {
      const user = db
        .prepare("INSERT INTO users (email, password_hash, name) VALUES (?,?,?)")
        .run(input.email.toLowerCase(), passwordHash, input.name);
      const org = db.prepare("INSERT INTO orgs (name, base_currency) VALUES (?,?)").run(input.orgName, input.baseCurrency);
      const userId = Number(user.lastInsertRowid);
      const orgId = Number(org.lastInsertRowid);
      db.prepare("INSERT INTO org_users (org_id, user_id, role) VALUES (?,?,'owner')").run(orgId, userId);
      storage.seedChartOfAccounts(orgId);
      storage.audit(orgId, userId, "create", "org", orgId, `Org "${input.orgName}" created (base ${input.baseCurrency})`);
      return { userId, orgId };
    });
    const { userId, orgId } = run();
    setSessionCookie(res, createSession(userId, orgId));
    res.status(201).json({ userId, orgId });
  }));

  router.post("/api/auth/login", loginRateLimit, h(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = db
      .prepare("SELECT id, password_hash, totp_enabled FROM users WHERE email = ?")
      .get(input.email.toLowerCase()) as { id: number; password_hash: string; totp_enabled: number } | undefined;
    if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
      recordLoginFailure(req);
      throw new HttpError(401, "invalid credentials");
    }
    // TASK 2: correct password on an MFA-enabled account yields a short-lived
    // single-use challenge token, NOT a session.
    if (user.totp_enabled === 1) {
      const token = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT INTO mfa_challenges (token, user_id, expires_at) VALUES (?,?, datetime('now','+5 minutes'))")
        .run(token, user.id);
      res.json({ mfaRequired: true, mfaToken: token });
      return;
    }
    const membership = db.prepare("SELECT org_id FROM org_users WHERE user_id = ? ORDER BY id LIMIT 1").get(user.id) as
      | { org_id: number }
      | undefined;
    if (!membership) throw new HttpError(403, "user has no organization");
    setSessionCookie(res, createSession(user.id, membership.org_id));
    res.json({ ok: true });
  }));

  router.post("/api/auth/mfa/verify", h(async (req, res) => {
    const input = mfaVerifySchema.parse(req.body);
    const challenge = db
      .prepare("SELECT * FROM mfa_challenges WHERE token = ? AND used = 0 AND expires_at > datetime('now')")
      .get(input.mfaToken) as
      | { token: string; user_id: number; attempts: number; window_start: string }
      | undefined;
    if (!challenge) throw new HttpError(401, "invalid or expired mfa token");

    // Rate limit: 5 verify attempts per minute per token.
    const windowStartMs = Date.parse(challenge.window_start.replace(" ", "T") + "Z");
    const withinWindow = Date.now() - windowStartMs < 60_000;
    if (withinWindow && challenge.attempts >= 5) {
      throw new HttpError(429, "too many attempts; wait a minute", "RATE_LIMITED");
    }
    if (withinWindow) {
      db.prepare("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token = ?").run(challenge.token);
    } else {
      db.prepare("UPDATE mfa_challenges SET attempts = 1, window_start = datetime('now') WHERE token = ?").run(challenge.token);
    }

    const user = db
      .prepare("SELECT id, totp_secret, recovery_codes FROM users WHERE id = ?")
      .get(challenge.user_id) as { id: number; totp_secret: string | null; recovery_codes: string | null };

    let ok = false;
    if (input.code && user.totp_secret) {
      ok = verifyTotp(vaultDecrypt(user.totp_secret), input.code);
    } else if (input.recoveryCode && user.recovery_codes) {
      const hashes: string[] = JSON.parse(user.recovery_codes);
      let idx = -1;
      for (let i = 0; i < hashes.length; i++) {
        if (await bcrypt.compare(input.recoveryCode, hashes[i])) { idx = i; break; }
      }
      if (idx >= 0) {
        hashes.splice(idx, 1); // single-use: burn the matched hash
        db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(hashes), user.id);
        ok = true;
      }
    }
    if (!ok) throw new HttpError(401, "invalid code");

    db.prepare("UPDATE mfa_challenges SET used = 1 WHERE token = ?").run(challenge.token);
    const membership = db.prepare("SELECT org_id FROM org_users WHERE user_id = ? ORDER BY id LIMIT 1").get(user.id) as
      | { org_id: number }
      | undefined;
    if (!membership) throw new HttpError(403, "user has no organization");
    setSessionCookie(res, createSession(user.id, membership.org_id));
    res.json({ ok: true });
  }));

  router.post("/api/auth/logout", requireAuth, h((req, res) => {
    const header = req.headers.cookie ?? "";
    const token = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(SESSION_COOKIE + "="))?.split("=")[1];
    if (token) destroySession(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  }));

  router.get("/api/auth/me", requireAuth, h((req, res) => {
    const c = ctx(req);
    const org = storage.getOrg(c.orgId);
    res.json({
      userId: c.userId, email: c.email, role: c.role, orgId: c.orgId,
      orgName: org.name, baseCurrency: org.base_currency, totpEnabled: c.totpEnabled,
    });
  }));

  /* ------------------------- TASK 2: MFA -------------------------- */
  // Pending secrets held server-side until the user proves possession.
  const pendingTotpSecrets = new Map<number, string>();

  router.post("/api/auth/mfa/setup", requireAuth, h((req, res) => {
    const c = ctx(req);
    const secret = generateTotpSecret();
    pendingTotpSecrets.set(c.userId, secret);
    res.json({ secret, otpauthUri: otpauthUri(secret, c.email) });
  }));

  router.post("/api/auth/mfa/enable", requireAuth, h(async (req, res) => {
    const c = ctx(req);
    const input = mfaEnableSchema.parse(req.body);
    const secret = pendingTotpSecrets.get(c.userId);
    if (!secret) throw new HttpError(400, "call /api/auth/mfa/setup first");
    if (!verifyTotp(secret, input.code)) throw new HttpError(400, "code does not match — check your authenticator clock");
    const recoveryCodes = generateRecoveryCodes(8);
    const hashes = await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)));
    db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 1, recovery_codes = ? WHERE id = ?")
      .run(vaultEncrypt(secret), JSON.stringify(hashes), c.userId);
    pendingTotpSecrets.delete(c.userId);
    storage.audit(c.orgId, c.userId, "update", "user", c.userId, "MFA enabled");
    // Plaintext recovery codes are shown exactly ONCE, here.
    res.json({ ok: true, recoveryCodes });
  }));

  router.post("/api/auth/mfa/disable", requireAuth, h(async (req, res) => {
    const c = ctx(req);
    const input = mfaDisableSchema.parse(req.body);
    const user = db.prepare("SELECT password_hash, totp_secret FROM users WHERE id = ?").get(c.userId) as {
      password_hash: string;
      totp_secret: string | null;
    };
    if (!(await bcrypt.compare(input.password, user.password_hash))) throw new HttpError(401, "wrong password");
    if (!user.totp_secret || !verifyTotp(vaultDecrypt(user.totp_secret), input.code)) throw new HttpError(401, "invalid code");
    db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0, recovery_codes = NULL WHERE id = ?").run(c.userId);
    storage.audit(c.orgId, c.userId, "update", "user", c.userId, "MFA disabled");
    res.json({ ok: true });
  }));

  /* ================================================================ */
  /* Business API — auth + owner-MFA gate                             */
  /* ================================================================ */

  const biz = Router();
  router.use("/api", requireAuth, enforceOwnerMfa, biz);

  /* --------------------------- accounts --------------------------- */

  biz.get("/accounts", h((req, res) => {
    res.json(db.prepare("SELECT * FROM accounts WHERE org_id = ? ORDER BY code").all(ctx(req).orgId));
  }));

  biz.post("/accounts", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const input = insertAccountSchema.parse(req.body);
    const exists = db.prepare("SELECT 1 FROM accounts WHERE org_id = ? AND code = ?").get(c.orgId, input.code);
    if (exists) throw new HttpError(409, `account code ${input.code} already exists`);
    const r = db.prepare("INSERT INTO accounts (org_id, code, name, type, subtype) VALUES (?,?,?,?,?)")
      .run(c.orgId, input.code, input.name, input.type, input.subtype);
    storage.audit(c.orgId, c.userId, "create", "account", Number(r.lastInsertRowid), `Account ${input.code} ${input.name}`);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  }));

  /* --------------------- customers & vendors ---------------------- */

  for (const [table, schema] of [["customers", insertCustomerSchema], ["vendors", insertVendorSchema]] as const) {
    biz.get(`/${table}`, h((req, res) => {
      res.json(db.prepare(`SELECT * FROM ${table} WHERE org_id = ? AND is_active = 1 ORDER BY name`).all(ctx(req).orgId));
    }));
    biz.post(`/${table}`, requireRole("owner", "admin", "accountant"), h((req, res) => {
      const c = ctx(req);
      const input = schema.parse(req.body);
      const r = db.prepare(
        `INSERT INTO ${table} (org_id, name, email, phone, address, shipping_city, shipping_state, shipping_zip, currency)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(c.orgId, input.name, input.email ?? null, input.phone ?? null, input.address ?? null,
        input.shippingCity ?? null, input.shippingState ?? null, input.shippingZip ?? null, input.currency ?? null);
      storage.audit(c.orgId, c.userId, "create", table.slice(0, -1), Number(r.lastInsertRowid), `${table.slice(0, -1)} ${input.name}`);
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    }));
    biz.put(`/${table}/:id`, requireRole("owner", "admin", "accountant"), h((req, res) => {
      const c = ctx(req);
      const id = Number(req.params.id);
      const input = schema.parse(req.body);
      const r = db.prepare(
        `UPDATE ${table} SET name=?, email=?, phone=?, address=?, shipping_city=?, shipping_state=?, shipping_zip=?, currency=?
         WHERE id = ? AND org_id = ?`,
      ).run(input.name, input.email ?? null, input.phone ?? null, input.address ?? null,
        input.shippingCity ?? null, input.shippingState ?? null, input.shippingZip ?? null, input.currency ?? null, id, c.orgId);
      if (r.changes === 0) throw new HttpError(404, "not found");
      storage.audit(c.orgId, c.userId, "update", table.slice(0, -1), id, `Updated ${input.name}`);
      res.json({ ok: true });
    }));
  }

  /* ---------------------- TASK 1: fx rates ------------------------ */

  biz.get("/settings/fx-rates", h((req, res) => {
    res.json({ baseCurrency: storage.getOrg(ctx(req).orgId).base_currency, rates: storage.listFxRates(ctx(req).orgId) });
  }));

  biz.put("/settings/fx-rates", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const input = fxRatesPutSchema.parse(req.body);
    const run = db.transaction(() => {
      for (const r of input.rates) storage.upsertFxRate(c.orgId, r.date, r.fromCode, r.toCode, r.rate, r.source);
    });
    run();
    storage.audit(c.orgId, c.userId, "update", "fx_rate", null, `Upserted ${input.rates.length} fx rate(s)`);
    res.json({ ok: true, count: input.rates.length });
  }));

  /* -------------------------- invoices ---------------------------- */

  biz.get("/invoices", h((req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    res.json(storage.listInvoices(ctx(req).orgId, page, pageSize, status));
  }));

  biz.post("/invoices", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const invoice = storage.createInvoice(c.orgId, c.userId, req.body);
    emitEvent(c.orgId, "invoice.created", { invoiceId: invoice.id, number: invoice.number, total: invoice.total, currency: invoice.currency || storage.getOrg(c.orgId).base_currency });
    res.status(201).json(invoice);
  }));

  biz.get("/invoices/:id", h((req, res) => {
    const c = ctx(req);
    const invoice = storage.getInvoice(c.orgId, Number(req.params.id));
    res.json({ ...invoice, lines: storage.invoiceLines(c.orgId, invoice.id) });
  }));

  biz.get("/invoices/:id/document", h((req, res) => {
    const c = ctx(req);
    const invoice = storage.getInvoice(c.orgId, Number(req.params.id));
    res.type("html").send(invoiceDocumentHtml(c.orgId, invoice.id));
  }));

  biz.post("/invoices/:id/pay", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const invoice = storage.payInvoice(c.orgId, c.userId, Number(req.params.id), req.body);
    if (invoice.status === "paid") {
      emitEvent(c.orgId, "invoice.paid", { invoiceId: invoice.id, number: invoice.number, total: invoice.total });
    }
    res.json(invoice);
  }));

  biz.post("/invoices/:id/void", requireRole("owner", "admin"), h((req, res) => {
    const c = ctx(req);
    const invoice = storage.voidInvoice(c.orgId, c.userId, Number(req.params.id));
    emitEvent(c.orgId, "invoice.voided", { invoiceId: invoice.id, number: invoice.number });
    res.json(invoice);
  }));

  /* ---------------------------- bills ----------------------------- */

  biz.get("/bills", h((req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    res.json(storage.listBills(ctx(req).orgId, page, pageSize, status));
  }));

  biz.post("/bills", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const bill = storage.createBill(c.orgId, c.userId, req.body);
    emitEvent(c.orgId, "bill.created", { billId: bill.id, number: bill.number, total: bill.total });
    res.status(201).json(bill);
  }));

  biz.get("/bills/:id", h((req, res) => {
    const c = ctx(req);
    const bill = storage.getBill(c.orgId, Number(req.params.id));
    res.json({ ...bill, lines: storage.billLines(c.orgId, bill.id) });
  }));

  biz.post("/bills/:id/pay", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const bill = storage.payBill(c.orgId, c.userId, Number(req.params.id), req.body);
    if (bill.status === "paid") emitEvent(c.orgId, "bill.paid", { billId: bill.id, number: bill.number, total: bill.total });
    res.json(bill);
  }));

  /* ------------------------- credit notes ------------------------- */

  biz.post("/credit-notes", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    insertCreditNoteSchema.parse(req.body);
    const cn = storage.createCreditNote(c.orgId, c.userId, req.body);
    emitEvent(c.orgId, "credit_note.issued", { creditNoteId: cn.id, number: cn.number, total: cn.total });
    res.status(201).json(cn);
  }));

  /* --------------------------- periods ---------------------------- */

  biz.post("/periods/close", requireRole("owner", "admin"), h((req, res) => {
    const c = ctx(req);
    const throughDate = isoDate.parse(req.body?.throughDate);
    db.prepare("INSERT INTO closed_periods (org_id, through_date, closed_by) VALUES (?,?,?)").run(c.orgId, throughDate, c.userId);
    storage.audit(c.orgId, c.userId, "close", "period", null, `Period closed through ${throughDate}`);
    emitEvent(c.orgId, "period.closed", { throughDate });
    res.json({ ok: true, throughDate });
  }));

  /* ------------------- customer statement (TASK 1) ---------------- */

  biz.get("/customers/:id/statement", h((req, res) => {
    const c = ctx(req);
    res.type("html").send(customerStatementHtml(c.orgId, Number(req.params.id)));
  }));

  /* ----------------------- TASK 4: reports ------------------------ */

  const money = (v: unknown) => ((v as number) / 100).toFixed(2);

  biz.get("/reports/trial-balance", h((req, res) => {
    const q = reportRangeSchema.parse(req.query);
    const rows = storage.trialBalance(ctx(req).orgId, q.to);
    if (q.format === "csv") {
      return sendCsv(res, "trial-balance.csv", rows, [
        { header: "Code", value: (r) => r.code },
        { header: "Account", value: (r) => r.name },
        { header: "Type", value: (r) => r.type },
        { header: "Debit", value: (r) => money(r.debit) },
        { header: "Credit", value: (r) => money(r.credit) },
      ]);
    }
    res.json(rows);
  }));

  biz.get("/reports/sales-by-customer", h((req, res) => {
    const q = reportRangeSchema.parse(req.query);
    const rows = storage.salesByCustomer(ctx(req).orgId, q.from, q.to);
    if (q.format === "csv") {
      return sendCsv(res, "sales-by-customer.csv", rows, [
        { header: "Customer", value: (r) => r.customer },
        { header: "Invoiced", value: (r) => money(r.invoiced) },
        { header: "Credited", value: (r) => money(r.credited) },
        { header: "Net", value: (r) => money(r.net) },
        { header: "Paid", value: (r) => money(r.paid) },
        { header: "Balance", value: (r) => money(r.balance) },
      ]);
    }
    res.json(rows);
  }));

  biz.get("/reports/expenses-by-vendor", h((req, res) => {
    const q = reportRangeSchema.parse(req.query);
    const rows = storage.expensesByVendor(ctx(req).orgId, q.from, q.to);
    if (q.format === "csv") {
      return sendCsv(res, "expenses-by-vendor.csv", rows, [
        { header: "Vendor", value: (r) => r.vendor },
        { header: "Billed", value: (r) => money(r.billed) },
        { header: "Paid", value: (r) => money(r.paid) },
        { header: "Balance", value: (r) => money(r.balance) },
      ]);
    }
    res.json(rows);
  }));

  biz.get("/reports/profit-loss-monthly", h((req, res) => {
    const q = reportRangeSchema.parse(req.query);
    const result = storage.profitLossMonthly(ctx(req).orgId, q.from, q.to);
    if (q.format === "csv") {
      const columns: CsvColumn<(typeof result.rows)[number]>[] = [
        { header: "Code", value: (r) => r.code },
        { header: "Account", value: (r) => r.name },
        { header: "Type", value: (r) => r.type },
        ...result.months.map((m) => ({ header: m, value: (r: (typeof result.rows)[number]) => money(r.amounts[m] ?? 0) })),
      ];
      return sendCsv(res, "profit-loss-monthly.csv", result.rows, columns);
    }
    res.json(result);
  }));

  biz.get("/reports/budget-vs-actual", h((req, res) => {
    const q = budgetVsActualQuerySchema.parse(req.query);
    const rows = storage.budgetVsActual(ctx(req).orgId, q.budgetId, q.from, q.to);
    if (q.format === "csv") {
      return sendCsv(res, "budget-vs-actual.csv", rows, [
        { header: "Code", value: (r) => r.code },
        { header: "Account", value: (r) => r.name },
        { header: "Type", value: (r) => r.type },
        { header: "Budget", value: (r) => money(r.budget) },
        { header: "Actual", value: (r) => money(r.actual) },
        { header: "Variance", value: (r) => money(r.variance) },
        { header: "Variance %", value: (r) => (r.variancePct === null ? "" : r.variancePct.toFixed(2)) },
      ]);
    }
    res.json(rows);
  }));

  /* ----------------------- TASK 4d: budgets ----------------------- */

  biz.get("/budgets", h((req, res) => {
    res.json(db.prepare("SELECT * FROM budgets WHERE org_id = ? ORDER BY fiscal_year DESC, name").all(ctx(req).orgId));
  }));

  biz.post("/budgets", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const input = insertBudgetSchema.parse(req.body);
    const r = db.prepare("INSERT INTO budgets (org_id, name, fiscal_year) VALUES (?,?,?)").run(c.orgId, input.name, input.fiscalYear);
    storage.audit(c.orgId, c.userId, "create", "budget", Number(r.lastInsertRowid), `Budget ${input.name} FY${input.fiscalYear}`);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  }));

  biz.get("/budgets/:id", h((req, res) => {
    const c = ctx(req);
    const budget = db.prepare("SELECT * FROM budgets WHERE org_id = ? AND id = ?").get(c.orgId, Number(req.params.id));
    if (!budget) throw new HttpError(404, "budget not found");
    const lines = db.prepare("SELECT * FROM budget_lines WHERE org_id = ? AND budget_id = ? ORDER BY account_id, month")
      .all(c.orgId, Number(req.params.id));
    res.json({ ...budget, lines });
  }));

  biz.put("/budgets/:id/lines", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const c = ctx(req);
    const budgetId = Number(req.params.id);
    const budget = db.prepare("SELECT id FROM budgets WHERE org_id = ? AND id = ?").get(c.orgId, budgetId);
    if (!budget) throw new HttpError(404, "budget not found");
    const input = putBudgetLinesSchema.parse(req.body);
    for (const l of input.lines) {
      if (!storage.accountById(c.orgId, l.accountId)) throw new HttpError(400, `account ${l.accountId} not in org`);
    }
    const run = db.transaction(() => {
      db.prepare("DELETE FROM budget_lines WHERE org_id = ? AND budget_id = ?").run(c.orgId, budgetId);
      const ins = db.prepare("INSERT INTO budget_lines (org_id, budget_id, account_id, month, amount) VALUES (?,?,?,?,?)");
      for (const l of input.lines) ins.run(c.orgId, budgetId, l.accountId, l.month, l.amount);
    });
    run();
    storage.audit(c.orgId, c.userId, "update", "budget", budgetId, `Replaced ${input.lines.length} budget line(s)`);
    res.json({ ok: true });
  }));

  biz.delete("/budgets/:id", requireRole("owner", "admin"), h((req, res) => {
    const c = ctx(req);
    const budgetId = Number(req.params.id);
    const run = db.transaction(() => {
      db.prepare("DELETE FROM budget_lines WHERE org_id = ? AND budget_id = ?").run(c.orgId, budgetId);
      const r = db.prepare("DELETE FROM budgets WHERE org_id = ? AND id = ?").run(c.orgId, budgetId);
      if (r.changes === 0) throw new HttpError(404, "budget not found");
    });
    run();
    storage.audit(c.orgId, c.userId, "delete", "budget", budgetId, "Budget deleted");
    res.json({ ok: true });
  }));

  /* --------------------- TASK 3: attachments ---------------------- */
  // Upload contract (documented): send the RAW file bytes as the request
  // body with the file's own Content-Type, plus ?entityType=&entityId=&
  // filename=. We chose express.raw over a hand-rolled multipart parser:
  // it is fewer moving parts, has no boundary/encoding edge cases, works
  // from fetch/curl one-liners, and the 10MB limit is enforced by express
  // itself. (A multipart parser would only add risk here.)

  const rawBody = express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES });

  biz.post("/attachments", requireRole("owner", "admin", "accountant"), rawBody, h(async (req, res) => {
    const c = ctx(req);
    const entityType = String(req.query.entityType ?? "");
    const entityId = Number(req.query.entityId ?? 0);
    const filename = String(req.query.filename ?? "upload.bin").slice(0, 200);
    const mime = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

    if (!(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(entityType)) throw new HttpError(400, "invalid entityType");
    if (!Number.isInteger(entityId) || entityId <= 0) throw new HttpError(400, "invalid entityId");
    if (!ATTACHMENT_MIME_WHITELIST[mime]) {
      throw new HttpError(415, `mime type ${mime || "(none)"} not allowed (pdf, png, jpg, webp, csv, xlsx)`);
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "empty body");
    if (body.length > ATTACHMENT_MAX_BYTES) throw new HttpError(413, "file exceeds 10MB limit");

    // Entity must exist AND belong to the current org — cross-org gets 404.
    const tableByType: Record<string, string> = {
      invoice: "invoices", bill: "bills", bank_transaction: "bank_transactions", journal_entry: "journal_entries",
    };
    const exists = db.prepare(`SELECT 1 FROM ${tableByType[entityType]} WHERE org_id = ? AND id = ?`).get(c.orgId, entityId);
    if (!exists) throw new HttpError(404, `${entityType} not found`);

    const storageKey = newStorageKey(c.orgId);
    await fileDriver().put(storageKey, body, mime);
    const r = db.prepare(
      `INSERT INTO attachments (org_id, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(c.orgId, entityType, entityId, filename, mime, body.length, storageKey, c.userId);
    storage.audit(c.orgId, c.userId, "upload", entityType, entityId, `Attachment ${filename} (${body.length} bytes)`);
    res.status(201).json({ id: Number(r.lastInsertRowid), filename, sizeBytes: body.length });
  }));

  biz.get("/attachments", h((req, res) => {
    const c = ctx(req);
    const entityType = String(req.query.entityType ?? "");
    const entityId = Number(req.query.entityId ?? 0);
    if (!(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(entityType) || !entityId) {
      throw new HttpError(400, "entityType and entityId are required");
    }
    res.json(
      db.prepare(
        `SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at
         FROM attachments WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id DESC`,
      ).all(c.orgId, entityType, entityId),
    );
  }));

  biz.get("/attachments/:id/download", h(async (req, res) => {
    const c = ctx(req);
    const row = db.prepare("SELECT * FROM attachments WHERE org_id = ? AND id = ?").get(c.orgId, Number(req.params.id)) as
      | { filename: string; mime_type: string; storage_key: string }
      | undefined;
    if (!row) throw new HttpError(404, "attachment not found");
    const data = await fileDriver().get(row.storage_key);
    res.setHeader("Content-Type", row.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${row.filename.replace(/"/g, "")}"`);
    res.send(data);
  }));

  biz.delete("/attachments/:id", requireRole("owner", "admin", "accountant"), h(async (req, res) => {
    const c = ctx(req);
    const row = db.prepare("SELECT * FROM attachments WHERE org_id = ? AND id = ?").get(c.orgId, Number(req.params.id)) as
      | { id: number; filename: string; storage_key: string; entity_type: string; entity_id: number }
      | undefined;
    if (!row) throw new HttpError(404, "attachment not found");
    await fileDriver().delete(row.storage_key);
    db.prepare("DELETE FROM attachments WHERE id = ? AND org_id = ?").run(row.id, c.orgId);
    storage.audit(c.orgId, c.userId, "delete", row.entity_type, row.entity_id, `Attachment ${row.filename} removed`);
    res.json({ ok: true });
  }));

  /* ----------------------- TASK 5: imports ------------------------ */
  // CSV arrives either as a raw text/csv body or as JSON { "csv": "..." }.

  const csvBody = express.text({ type: ["text/csv", "text/plain"], limit: "10mb" });
  const readCsv = (req: Request): string => {
    if (typeof req.body === "string" && req.body.trim()) return req.body;
    if (req.body && typeof req.body === "object" && typeof (req.body as Record<string, unknown>).csv === "string") {
      return (req.body as Record<string, string>).csv;
    }
    throw new HttpError(400, "send CSV as text/csv body or JSON {\"csv\": \"...\"}");
  };
  const isDryRun = (req: Request): boolean => String(req.query.dryRun) === "true";

  biz.post("/import/customers", requireRole("owner", "admin", "accountant"), csvBody, h((req, res) => {
    const c = ctx(req);
    res.json(importers.importCustomers(c.orgId, c.userId, readCsv(req), isDryRun(req)));
  }));

  biz.post("/import/vendors", requireRole("owner", "admin", "accountant"), csvBody, h((req, res) => {
    const c = ctx(req);
    res.json(importers.importVendors(c.orgId, c.userId, readCsv(req), isDryRun(req)));
  }));

  biz.post("/import/chart-of-accounts", requireRole("owner", "admin", "accountant"), csvBody, h((req, res) => {
    const c = ctx(req);
    res.json(importers.importChartOfAccounts(c.orgId, c.userId, readCsv(req), isDryRun(req)));
  }));

  biz.post("/import/invoices", requireRole("owner", "admin", "accountant"), csvBody, h((req, res) => {
    const c = ctx(req);
    const partial = String(req.query.partial) === "true";
    const result = importers.importInvoices(c.orgId, c.userId, readCsv(req), isDryRun(req), partial);
    res.status(result.errors.length > 0 && result.inserted === 0 && !partial ? 400 : 200).json(result);
  }));

  biz.post("/import/opening-balances", requireRole("owner", "admin", "accountant"), csvBody, h((req, res) => {
    const c = ctx(req);
    const asOfDate = openingBalanceMetaSchema.parse({ asOfDate: req.query.asOfDate ?? (req.body as Record<string, unknown>)?.asOfDate }).asOfDate;
    const result = importers.importOpeningBalances(c.orgId, c.userId, readCsv(req), asOfDate, isDryRun(req));
    res.status(result.errors.length > 0 ? 400 : 200).json(result);
  }));

  /* ----------------------- TASK 6: webhooks ----------------------- */

  const guardUrl = async (url: string): Promise<void> => {
    try {
      await assertUrlIsPublic(url);
    } catch (err) {
      throw new HttpError(400, `webhook URL rejected: ${(err as Error).message}`, "SSRF_BLOCKED");
    }
  };

  biz.get("/webhooks", requireRole("owner", "admin"), h((req, res) => {
    const rows = db.prepare("SELECT id, url, events, is_active, created_at FROM webhooks WHERE org_id = ?").all(ctx(req).orgId) as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, events: JSON.parse(String(r.events)) })));
  }));

  biz.post("/webhooks", requireRole("owner", "admin"), h(async (req, res) => {
    const c = ctx(req);
    const input = insertWebhookSchema.parse(req.body);
    await guardUrl(input.url); // SSRF guard at create time
    const secret = crypto.randomBytes(24).toString("hex");
    const r = db.prepare("INSERT INTO webhooks (org_id, url, secret, events, is_active) VALUES (?,?,?,?,?)")
      .run(c.orgId, input.url, secret, JSON.stringify(input.events), input.isActive ? 1 : 0);
    storage.audit(c.orgId, c.userId, "create", "webhook", Number(r.lastInsertRowid), `Webhook ${input.url}`);
    // Secret is returned once at creation so the receiver can verify signatures.
    res.status(201).json({ id: Number(r.lastInsertRowid), secret });
  }));

  biz.put("/webhooks/:id", requireRole("owner", "admin"), h(async (req, res) => {
    const c = ctx(req);
    const input = insertWebhookSchema.parse(req.body);
    await guardUrl(input.url);
    const r = db.prepare("UPDATE webhooks SET url = ?, events = ?, is_active = ? WHERE id = ? AND org_id = ?")
      .run(input.url, JSON.stringify(input.events), input.isActive ? 1 : 0, Number(req.params.id), c.orgId);
    if (r.changes === 0) throw new HttpError(404, "webhook not found");
    storage.audit(c.orgId, c.userId, "update", "webhook", Number(req.params.id), `Webhook ${input.url}`);
    res.json({ ok: true });
  }));

  biz.delete("/webhooks/:id", requireRole("owner", "admin"), h((req, res) => {
    const c = ctx(req);
    const id = Number(req.params.id);
    const run = db.transaction(() => {
      db.prepare("DELETE FROM webhook_deliveries WHERE org_id = ? AND webhook_id = ?").run(c.orgId, id);
      const r = db.prepare("DELETE FROM webhooks WHERE id = ? AND org_id = ?").run(id, c.orgId);
      if (r.changes === 0) throw new HttpError(404, "webhook not found");
    });
    run();
    storage.audit(c.orgId, c.userId, "delete", "webhook", id, "Webhook deleted");
    res.json({ ok: true });
  }));

  biz.post("/webhooks/:id/test", requireRole("owner", "admin"), h(async (req, res) => {
    const c = ctx(req);
    const hook = db.prepare("SELECT * FROM webhooks WHERE org_id = ? AND id = ?").get(c.orgId, Number(req.params.id)) as
      | { id: number }
      | undefined;
    if (!hook) throw new HttpError(404, "webhook not found");
    db.prepare(
      `INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload, status, attempts, next_attempt_at)
       VALUES (?,?,?,?, 'pending', 0, datetime('now'))`,
    ).run(c.orgId, hook.id, "ping", JSON.stringify({ event: "ping", orgId: c.orgId, occurredAt: new Date().toISOString(), data: {} }));
    await runDeliveryPass(); // deliver the ping right away
    const delivery = db.prepare(
      "SELECT status, response_code, attempts FROM webhook_deliveries WHERE org_id = ? AND webhook_id = ? ORDER BY id DESC LIMIT 1",
    ).get(c.orgId, hook.id);
    res.json({ ok: true, delivery });
  }));

  biz.get("/webhooks/:id/deliveries", requireRole("owner", "admin"), h((req, res) => {
    const c = ctx(req);
    res.json(
      db.prepare(
        `SELECT id, event, status, attempts, response_code, next_attempt_at, created_at
         FROM webhook_deliveries WHERE org_id = ? AND webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
      ).all(c.orgId, Number(req.params.id)),
    );
  }));

  biz.get("/webhook-events", h((_req, res) => res.json(WEBHOOK_EVENTS)));

  /* --------------------- TASK 7: audit log ------------------------ */

  biz.get("/audit-log", requireRole("owner", "admin", "accountant"), h((req, res) => {
    const q = auditQuerySchema.parse(req.query);
    // CSV must match the ENTIRE filtered view, not one page: override
    // pagination for exports (hard cap keeps a runaway export bounded).
    const filters = q.format === "csv" ? { ...q, page: 1, pageSize: 100_000 } : q;
    const { rows, total } = storage.queryAuditLog(ctx(req).orgId, filters);
    if (q.format === "csv") {
      return sendCsv(res, "audit-log.csv", rows as Array<Record<string, unknown>>, [
        { header: "Time", value: (r) => r.created_at },
        { header: "User", value: (r) => r.user_email ?? "" },
        { header: "Action", value: (r) => r.action },
        { header: "Entity", value: (r) => r.entity_type },
        { header: "Entity ID", value: (r) => r.entity_id ?? "" },
        { header: "Summary", value: (r) => r.summary },
      ]);
    }
    res.json({ rows, total, page: q.page, pageSize: q.pageSize });
  }));

  /* ------------------------- error handler ------------------------ */

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation failed", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      return;
    }
    if (err && typeof err === "object" && "type" in err) {
      const type = (err as { type: string }).type;
      if (type === "entity.too.large") {
        res.status(413).json({ error: "body exceeds size limit" });
        return;
      }
      if (type === "entity.parse.failed" || type === "charset.unsupported" || type === "encoding.unsupported") {
        res.status(400).json({ error: "malformed request body" });
        return;
      }
    }
    // check-then-insert races (e.g. two concurrent registrations with the
    // same email) land on the UNIQUE constraint: that's a conflict, not a 500.
    if (err && typeof err === "object" && "code" in err && String((err as { code: string }).code).startsWith("SQLITE_CONSTRAINT")) {
      res.status(409).json({ error: "conflict: resource already exists" });
      return;
    }
    console.error("unhandled error:", err);
    res.status(500).json({ error: "internal server error" });
  });

  return router;
}
