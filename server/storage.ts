import {
  accounts,
  customers,
  vendors,
  journalEntries,
  journalLines,
  invoices,
  invoiceLines,
  bills,
  billLines,
  bankTransactions,
  bankRules,
  reconciliations,
  reconciliationItems,
  recurringTemplates,
  taxCodes,
  periodLocks,
  auditLog,
  invoiceShares,
  orgNexusStates,
  creditNotes,
  debitNotes,
  items,
  inventoryMovements,
  inventoryLayers,
  purchaseOrders,
  purchaseOrderLines,
  estimates,
  estimateLines,
  estimateShares,
  fixedAssets,
  depreciationEntries,
  fxRevaluations,
  fxRevaluationLines,
  employees,
  payrollRuns,
  payrollItems,
  payrollLiabilityPayments,
  payrollLiabilityPaymentLines,
  classes,
  locations,
  projects,
  type OrgNexusState,
  type NexusStateInput,
  type Class,
  type InsertClass,
  type Location,
  type InsertLocation,
  type Project,
  type InsertProject,
} from "@shared/schema";
import { organizations } from "@shared/auth-schema";
import { applyPurchase, costOfSale, buildCogsJournalLines, relieveLayers, layerValuation, type CogsComponent } from "@shared/inventory";
import { computeDepreciationSchedule, lastDayOfPeriod, periodOf, addMonthsToPeriod, type DepreciationPeriod } from "@shared/depreciation";
import { computeEmployeePayroll, salaryGrossForPeriod, hourlyGross, type EmployeePayrollResult } from "@shared/payroll";
import type {
  Account,
  InsertAccount,
  Customer,
  InsertCustomer,
  Vendor,
  InsertVendor,
  JournalEntry,
  JournalLine,
  PostJournalEntry,
  Invoice,
  InvoiceLine,
  CreateInvoiceInput,
  Bill,
  BillLine,
  CreateBillInput,
  PayInvoiceInput,
  PayBillInput,
  BankTransaction,
  PostBankTransactionInput,
  ImportBankTransactionsInput,
  MatchBankTransactionInput,
  BankRule,
  BankRuleInput,
  Reconciliation,
  ReconciliationItem,
  StartReconciliationInput,
  RecurringTemplate,
  CreateRecurringInput,
  ReclassifyInput,
  TaxCode,
  TaxCodeInput,
  PeriodLock,
  ClosePeriodInput,
  YearEndCloseInput,
  AuditEntry,
  InvoiceShare,
  Paginated,
  Item,
  InsertItem,
  UpdateItem,
  InventoryMovement,
  PurchaseOrder,
  PurchaseOrderLine,
  CreatePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  ReceivePurchaseOrderInput,
  Estimate,
  EstimateLine,
  EstimateShare,
  CreateEstimateInput,
  UpdateEstimateInput,
  ConvertEstimateInput,
  FixedAsset,
  DepreciationEntry,
  CreateFixedAssetInput,
  UpdateFixedAssetInput,
  DisposeFixedAssetInput,
  FxRevaluation,
  FxRevaluationLine,
  RevalueFxInput,
  Employee,
  PayrollRun,
  PayrollItem,
  CreateEmployeeInput,
  UpdateEmployeeInput,
  CreatePayrollRunInput,
  PayrollLiabilityPayment,
  PayPayrollLiabilitiesInput,
} from "@shared/schema";
import crypto from "node:crypto";
import { toCents, formatMoney } from "@shared/money";
import { futureDatedWarning } from "@shared/dates";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, ne, sql, and, gt, gte, lte, desc, inArray } from "drizzle-orm";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { currentOrgId, currentUserId, withOrg } from "./org-scope";
import { encryptSecret, decryptSecret, isLegacyPlaintext, encryptionAvailable, assertEncryptionKey } from "./crypto-vault";
import { logger } from "./logger";
import { emitWebhookEvent } from "./webhooks";
import { calculateSalesTax, taxjarConfigured, type CalculateSalesTaxResult } from "./taxjar";
import { sendEmail, smtpStatus, appBaseUrl } from "./email";

// ----------------------------------------------------------------------------
// PostgreSQL connection — SINGLE shared pool for the entire app.
// auth.ts and creditNoteService.ts import { db, pool } from here; nothing else
// may open its own connection.
// ----------------------------------------------------------------------------
const { Pool, types } = pg;

// PostgreSQL returns BIGINT (int8) and NUMERIC as strings by default (JS number
// precision caveat). This ledger stores integer cents well inside 2^53, so we
// parse both to Number globally — otherwise every SUM() in the report queries
// would come back as a string and silently concatenate instead of add.
types.setTypeParser(20, (v: string) => parseInt(v, 10));      // int8 / BIGINT (money columns, COUNT, SUM of int)
types.setTypeParser(1700, (v: string) => parseFloat(v));      // NUMERIC (SUM of bigint money)

// DATABASE_URL is required. Format: postgresql://user:pass@host:5432/dbname
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Example: postgresql://user:pass@localhost:5432/ledgerlite"
  );
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  min: Number(process.env.PG_POOL_MIN || 2),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Surface pool-level errors (e.g. backend restarts) instead of crashing silently.
pool.on("error", (err) => {
  logger.error("[pg] idle client error", { error: err.message });
});

export const db = drizzle(pool);

// ----------------------------------------------------------------------------
// DB health check — used by GET /api/health.
// ----------------------------------------------------------------------------
export async function dbHealthCheck(): Promise<{ db: "ok" } | { db: "error"; message: string }> {
  try {
    await pool.query("SELECT 1");
    return { db: "ok" };
  } catch (err: any) {
    return { db: "error", message: err?.message || "unknown error" };
  }
}

// ----------------------------------------------------------------------------
// Migrations — ordered .sql files in migrations/pg/, tracked in
// schema_migrations so each runs exactly once. Replaces the old SQLite
// initSchema()/sqlite.exec() bootstrap.
// ----------------------------------------------------------------------------
const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations", "pg");

export async function runMigrations(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT now()
  )`);
  const { rows: appliedRows } = await pool.query("SELECT name FROM schema_migrations");
  const applied = new Set(appliedRows.map((r: any) => r.name));

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
    : [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sqlText);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      // Migration bootstrap runs during initDatabase(); the logger is
      // dependency-free so it's safe here too.
      logger.info(`[migration] applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

// ----------------------------------------------------------------------------
// Default Chart of Accounts (US-style for SMB)
// ----------------------------------------------------------------------------
const DEFAULT_COA: InsertAccount[] = [
  // Assets (1000-1999)
  { code: "1000", name: "Checking Account", type: "asset", subtype: "bank", isActive: true },
  { code: "1010", name: "Savings Account", type: "asset", subtype: "bank", isActive: true },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "current_asset", isActive: true },
  { code: "1150", name: "Sales Tax Receivable", type: "asset", subtype: "current_asset", isActive: true },
  { code: "1200", name: "Inventory", type: "asset", subtype: "current_asset", isActive: true },
  { code: "1500", name: "Office Equipment", type: "asset", subtype: "fixed_asset", isActive: true },
  { code: "1510", name: "Accumulated Depreciation", type: "asset", subtype: "accumulated_depreciation", isActive: true },
  // Liabilities (2000-2999)
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "current_liability", isActive: true },
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "current_liability", isActive: true },
  { code: "2200", name: "Credit Card", type: "liability", subtype: "credit_card", isActive: true },
  { code: "2300", name: "Payroll Taxes Payable", type: "liability", subtype: "current_liability", isActive: true },
  { code: "2310", name: "Payroll Deductions Payable", type: "liability", subtype: "current_liability", isActive: true },
  // Equity (3000-3999)
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "equity", isActive: true },
  { code: "3100", name: "Retained Earnings", type: "equity", subtype: "equity", isActive: true },
  // Income (4000-4999)
  { code: "4000", name: "Sales Revenue", type: "income", subtype: "operating_income", isActive: true },
  { code: "4100", name: "Service Revenue", type: "income", subtype: "operating_income", isActive: true },
  { code: "4900", name: "Other Income", type: "income", subtype: "other_income", isActive: true },
  { code: "4910", name: "Gain/Loss on Asset Disposal", type: "income", subtype: "other_income", isActive: true },
  // Expenses (5000-5999)
  { code: "5000", name: "Cost of Goods Sold", type: "expense", subtype: "cogs", isActive: true },
  { code: "6800", name: "Depreciation Expense", type: "expense", subtype: "depreciation_expense", isActive: true },
  { code: "6000", name: "Rent Expense", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6100", name: "Utilities", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6200", name: "Office Supplies", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6300", name: "Salaries & Wages", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6350", name: "Payroll Tax Expense", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6400", name: "Marketing & Advertising", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6500", name: "Software & Subscriptions", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6600", name: "Professional Fees", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6700", name: "Travel & Meals", type: "expense", subtype: "operating_expense", isActive: true },
  { code: "6900", name: "Bank Fees", type: "expense", subtype: "operating_expense", isActive: true },
];

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Maps a computed payroll result onto the payroll_items money columns.
function payrollItemColumns(r: EmployeePayrollResult) {
  return {
    grossCents: r.grossCents,
    preTaxDeductionCents: r.preTaxCents,
    postTaxDeductionCents: r.postTaxCents,
    fedWithholdingCents: r.fedWithholdingCents,
    stateWithholdingCents: r.stateWithholdingCents,
    ssEmployeeCents: r.ssEmployeeCents,
    medicareEmployeeCents: r.medicareEmployeeCents,
    additionalMedicareCents: r.additionalMedicareCents,
    ssEmployerCents: r.ssEmployerCents,
    medicareEmployerCents: r.medicareEmployerCents,
    futaCents: r.futaCents,
    sutaCents: r.sutaCents,
    employeeTaxCents: r.employeeTaxCents,
    employerTaxCents: r.employerTaxCents,
    netCents: r.netCents,
  };
}

// Seed the default chart of accounts for a specific org. Called at org creation
// (signup and POST /api/orgs). Idempotent: skips if the org already has accounts.
export async function seedOrgDefaults(orgId: number): Promise<void> {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM accounts WHERE org_id = $1", [orgId]);
  if (rows[0].c > 0) return;
  await db.transaction(async (tx) => {
    for (const a of DEFAULT_COA) {
      await tx.insert(accounts).values({ ...a, orgId });
    }
  });
}

// Legacy bootstrap: seed org 1 if the whole table is empty (first boot of a fresh DB).
async function seedDefaultsIfEmpty(): Promise<void> {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM accounts");
  if (rows[0].c === 0) await seedOrgDefaults(1);
}

// ----------------------------------------------------------------------------
// initDatabase — the async bootstrap. index.ts MUST await this before
// registering routes. Replaces the old import-time initSchema() side effect
// (PostgreSQL connections are async; import-time DDL is impossible).
// ----------------------------------------------------------------------------
let initialized = false;
// Connection-class error codes worth retrying at boot: the database container
// may simply not be up yet (docker compose start ordering). SQL errors — a
// broken migration — must FAIL FAST, not retry ten times into the same wall.
const RETRYABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P03" /* cannot_connect_now */]);
function isConnectionError(err: any): boolean {
  return RETRYABLE_CODES.has(err?.code) || RETRYABLE_CODES.has(err?.errors?.[0]?.code /* AggregateError from net */);
}

export async function initDatabase(): Promise<void> {
  if (initialized) return;
  // Encryption key contract (crypto-vault): production refuses to boot
  // without a valid APP_ENCRYPTION_KEY — never silently store plaintext secrets.
  assertEncryptionKey();
  // Boot retry (Task: docker compose ordering). Delays 1s,2s,4s,8s,15s,15s...
  // capped at 15s, max 10 attempts. Connection-class errors only.
  const MAX_ATTEMPTS = 10;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runMigrations();
      break;
    } catch (err: any) {
      if (!isConnectionError(err) || attempt === MAX_ATTEMPTS) throw err;
      const delayS = Math.min(2 ** (attempt - 1), 15);
      logger.warn(`[db] connection attempt ${attempt} failed: ${err.message}, retrying in ${delayS}s`);
      await new Promise((r) => setTimeout(r, delayS * 1000));
    }
  }
  await seedDefaultsIfEmpty();
  initialized = true;
  logger.info(`[db] PostgreSQL ready (pool min=${process.env.PG_POOL_MIN || 2} max=${process.env.PG_POOL_MAX || 10})`);
}

// Graceful shutdown — drain the pool.
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

// Optional dimensional filter for reports (class/location/project tracking).
export type DimFilter = { classId?: number | null; locationId?: number | null; projectId?: number | null };

// ----------------------------------------------------------------------------
// Storage
// ----------------------------------------------------------------------------
export class DatabaseStorage {
  // ============================================================================
  // SPRINT C: AUDIT LOG
  // ============================================================================
  async audit(action: string, entityType: string, entityId: number | null, summary: string, metadata?: any) {
    try {
      await db.insert(auditLog)
        .values({
          orgId: currentOrgId(),
          ts: nowIso(),
          user: String(currentUserId() ?? "system"),
          action,
          entityType,
          entityId: entityId ?? null,
          summary,
          metadata: metadata ? JSON.stringify(metadata) : null,
        })
        ;
    } catch (e) {
      // Audit must never break the operation
      logger.warn("audit log write failed", { error: (e as Error)?.message });
    }
  }
  async listAuditLog(
    opts: { limit?: number; offset?: number; entityType?: string; action?: string; from?: string; to?: string; userId?: string; entityId?: number; q?: string } = {}
  ): Promise<Paginated<AuditEntry>> {
    // Pagination contract: limit 1..200 (default 50), offset >= 0 (default 0).
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const conditions: any[] = [eq(auditLog.orgId, currentOrgId())];
    if (opts.entityType) conditions.push(eq(auditLog.entityType, opts.entityType));
    if (opts.action) conditions.push(eq(auditLog.action, opts.action));
    if (opts.from) conditions.push(gte(auditLog.ts, opts.from));
    if (opts.to) conditions.push(lte(auditLog.ts, opts.to + " 23:59:59"));
    if (opts.userId) conditions.push(eq(auditLog.user, opts.userId));
    if (opts.entityId !== undefined) conditions.push(eq(auditLog.entityId, opts.entityId));
    if (opts.q) {
      // Free-text search on summary. % and _ are LIKE wildcards — escape them
      // so a user searching for "50%" doesn't match everything.
      const escaped = opts.q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push(sql`${auditLog.summary} ILIKE ${"%" + escaped + "%"}`);
    }
    const where = and(...conditions);
    // total MUST use the SAME WHERE clause as the page query.
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(auditLog).where(where);
    const rows = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }

  // ============================================================================
  // SPRINT C: PERIOD LOCKS
  // ============================================================================
  async listPeriodLocks(): Promise<PeriodLock[]> {
    return await db.select().from(periodLocks).where(eq(periodLocks.orgId, currentOrgId())).orderBy(desc(periodLocks.lockDate));
  }
  // Returns the most recent lockDate (the effective close cutoff). Postings with date <= this are blocked.
  async effectiveLockDate(): Promise<string | null> {
    const row = (await db
      .select()
      .from(periodLocks)
      .where(eq(periodLocks.orgId, currentOrgId()))
      .orderBy(desc(periodLocks.lockDate))
      .limit(1)
    )[0];
    return row?.lockDate ?? null;
  }
  async isDateLocked(date: string): Promise<boolean> {
    const lock = await this.effectiveLockDate();
    return lock !== null && date <= lock;
  }

  // ---------------------------------------------------------------------------
  // Future-dated document policy (BUG-005). Reads the org's grace-days + strict
  // flag once. `checkFutureDate` either returns a non-blocking warning string
  // (soft mode) or throws a 400 (strict mode). Callers run it BEFORE any write
  // so a rejected document never touches the ledger, and attach the returned
  // warning to their response so the client can surface it.
  // ---------------------------------------------------------------------------
  private async futureDatePolicy(): Promise<{ graceDays: number; strict: boolean }> {
    const row = await db
      .select({ grace: organizations.futureDatedGraceDays, strict: organizations.strictFutureDates })
      .from(organizations)
      .where(eq(organizations.id, currentOrgId()))
      .then((r: any[]) => r[0]);
    return { graceDays: row?.grace ?? 0, strict: !!row?.strict };
  }

  async checkFutureDate(date: string, docLabel: string): Promise<string | null> {
    const { graceDays, strict } = await this.futureDatePolicy();
    const warning = futureDatedWarning(date, graceDays, docLabel);
    if (!warning) return null;
    if (strict) {
      const err: any = new Error(`${warning} Strict mode is enabled, so this ${docLabel} cannot be saved.`);
      err.httpStatus = 400;
      throw err;
    }
    return warning;
  }
  async closePeriod(input: ClosePeriodInput): Promise<PeriodLock> {
    // Sanity: must be after the previous lock date
    const prev = await this.effectiveLockDate();
    if (prev && input.lockDate <= prev) {
      throw new Error(`A later period is already closed through ${prev}. Choose a date after that.`);
    }
    const row = await db
      .insert(periodLocks)
      .values({ orgId: currentOrgId(), lockDate: input.lockDate, reason: input.reason, isYearEnd: false, createdAt: nowIso() })
      .returning().then((r) => r[0]);
    await this.audit("close", "period", row.id, `Closed period through ${input.lockDate}`, { reason: input.reason });
    await emitWebhookEvent("period.closed", { lockDate: input.lockDate, reason: input.reason ?? null });
    return row;
  }
  async reopenPeriod(id: number): Promise<{ ok: true }> {
    const lock = await db
      .select()
      .from(periodLocks)
      .where(and(eq(periodLocks.id, id), eq(periodLocks.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!lock) throw new Error("Period lock not found");

    // Block reopening if a NEWER period lock exists — that would create inconsistency
    // (reopening Q4 2024 when 2025 year-end has been closed leaves the 2025 closing
    // entry built on assumptions about Q4 2024 that may no longer hold).
    const newer = await db
      .select()
      .from(periodLocks)
      .where(and(gt(periodLocks.lockDate, lock.lockDate), eq(periodLocks.orgId, currentOrgId())))
      ;
    if (newer.length > 0) {
      throw new Error(
        `Cannot reopen ${lock.lockDate}: ${newer.length} newer period lock(s) exist (latest: ${newer[newer.length - 1].lockDate}). Reopen newer periods first.`
      );
    }

    if (lock.isYearEnd && lock.closingEntryId) {
      // Delete the closing JE so books rebalance
      await db.delete(journalLines).where(eq(journalLines.entryId, lock.closingEntryId));
      await db.delete(journalEntries).where(eq(journalEntries.id, lock.closingEntryId));
    }
    await db.delete(periodLocks).where(eq(periodLocks.id, id));
    await this.audit("reopen", "period", id, `Reopened period (was closed through ${lock.lockDate})`);
    return { ok: true };
  }
  async yearEndClose(input: YearEndCloseInput): Promise<{ lock: PeriodLock; entry: JournalEntry; netIncome: number }> {
    const fyEnd = input.fiscalYearEnd;
    // Fiscal year start: use input.fiscalYearStart if provided, else compute the date
    // exactly one year minus one day before fyEnd. Calendar-year fyStart=Jan 1 is the
    // common case but customers with July or April year-ends need this flexibility.
    const fyStart = (input as any).fiscalYearStart ?? (() => {
      const d = new Date(fyEnd + "T00:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    // Prevent double-close: a year-end lock for this fyEnd already exists
    const existing = await db
      .select()
      .from(periodLocks)
      .where(and(eq(periodLocks.lockDate, fyEnd), eq(periodLocks.isYearEnd, true), eq(periodLocks.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (existing) {
      throw new Error(
        `Year ending ${fyEnd} is already closed (lock #${existing.id}). Reopen it first if you need to re-run.`
      );
    }

    const re = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, "3100"), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!re) throw new Error("Retained Earnings account (3100) is missing");

    // Compute net income = income credits - income debits - (expense debits - expense credits)
    const allAccounts = await this.listAccounts();
    const lines: any[] = [];
    let netIncome = 0;
    for (const a of allAccounts) {
      if (a.type !== "income" && a.type !== "expense") continue;
      const sums = (await pool.query(`SELECT COALESCE(SUM(jl.debit),0) as dr, COALESCE(SUM(jl.credit),0) as cr
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           WHERE jl.account_id = $1 AND je.date >= $2 AND je.date <= $3`, [a.id, fyStart, fyEnd])).rows[0] as { dr: number; cr: number };
      const dr = sums.dr || 0;
      const cr = sums.cr || 0;
      if (a.type === "income") {
        const bal = (cr - dr);
        if (bal === 0) continue;
        netIncome += bal;
        if (bal > 0) {
          lines.push({ accountId: a.id, debit: bal, credit: 0, description: `Year-end close: ${a.name}` });
        } else {
          lines.push({ accountId: a.id, debit: 0, credit: -bal, description: `Year-end close: ${a.name}` });
        }
      } else {
        const bal = (dr - cr);
        if (bal === 0) continue;
        netIncome -= bal;
        if (bal > 0) {
          lines.push({ accountId: a.id, debit: 0, credit: bal, description: `Year-end close: ${a.name}` });
        } else {
          lines.push({ accountId: a.id, debit: -bal, credit: 0, description: `Year-end close: ${a.name}` });
        }
      }
    }
    if (netIncome > 0) {
      lines.push({ accountId: re.id, debit: 0, credit: netIncome, description: `Net income to Retained Earnings` });
    } else if (netIncome < 0) {
      lines.push({ accountId: re.id, debit: -netIncome, credit: 0, description: `Net loss from Retained Earnings` });
    } else {
      throw new Error("No income or expense activity to close for the year");
    }

    if (lines.length < 2) throw new Error("Nothing to close for this year");

    // Post the closing entry with bypassLock=true since we're posting AT the close date
    const { entry } = await this.postJournalEntry({
      date: fyEnd,
      memo: `Year-end close ${fyEnd.slice(0, 4)}`,
      reference: `YE-${fyEnd.slice(0, 4)}`,
      source: "manual",
      lines,
    }, { bypassLock: true });

    const lock = await db
      .insert(periodLocks)
      .values({
          orgId: currentOrgId(),
        lockDate: fyEnd,
        reason: `Year-end close ${fyEnd.slice(0, 4)} (net ${netIncome >= 0 ? "income" : "loss"} ${formatMoney(Math.abs(netIncome))})`,
        isYearEnd: true,
        closingEntryId: entry.id,
        createdAt: nowIso(),
      })
      .returning().then((r) => r[0]);
    await this.audit("yearEndClose", "period", lock.id, `Year-end close ${fyEnd}: net ${netIncome >= 0 ? "income" : "loss"} ${formatMoney(Math.abs(netIncome))}`, {
      netIncome,
      entryId: entry.id,
    });
    return { lock, entry, netIncome };
  }

  // ============================================================================
  // SPRINT C: TAX CODES
  // ============================================================================
  async listTaxCodes(): Promise<TaxCode[]> {
    return await db.select().from(taxCodes).where(eq(taxCodes.orgId, currentOrgId())).orderBy(taxCodes.name);
  }
  async getTaxCode(id: number): Promise<TaxCode | undefined> {
    return await db.select().from(taxCodes).where(and(eq(taxCodes.id, id), eq(taxCodes.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async createTaxCode(data: TaxCodeInput): Promise<TaxCode> {
    const liab = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, data.liabilityAccountId), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!liab) throw new Error("Liability account not found");
    if (liab.type !== "liability") throw new Error("Tax code must point at a liability account");
    const row = await db.insert(taxCodes).values({ ...data, orgId: currentOrgId(), createdAt: nowIso() }).returning().then((r) => r[0]);
    await this.audit("create", "tax_code", row.id, `Created tax code ${row.name} ${row.rate}%`);
    return row;
  }
  async updateTaxCode(id: number, data: Partial<TaxCodeInput>): Promise<TaxCode> {
    const existing = await this.getTaxCode(id);
    if (!existing) throw new Error("Tax code not found");
    if (data.liabilityAccountId !== undefined) {
      const liab = await this.getAccount(data.liabilityAccountId);
      if (!liab) throw new Error("Liability account not found");
      if (liab.type !== "liability") throw new Error("Tax code must point at a liability account");
    }
    const row = await db
      .update(taxCodes)
      .set(data)
      .where(and(eq(taxCodes.id, id), eq(taxCodes.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
    await this.audit("update", "tax_code", id, `Updated tax code ${row.name}`);
    return row;
  }
  async deleteTaxCode(id: number) {
    const existing = await this.getTaxCode(id);
    if (!existing) throw new Error("Tax code not found");
    await db.delete(taxCodes).where(and(eq(taxCodes.id, id), eq(taxCodes.orgId, currentOrgId())));
    await this.audit("delete", "tax_code", id, `Deleted tax code ${id}`);
  }
  // ============================================================================
  // SALES-TAX NEXUS (TaxJar integration)
  // ============================================================================
  async listNexusStates(): Promise<OrgNexusState[]> {
    return db
      .select()
      .from(orgNexusStates)
      .where(eq(orgNexusStates.orgId, currentOrgId()))
      .orderBy(orgNexusStates.stateCode)
      ;
  }
  async addNexusState(input: NexusStateInput): Promise<OrgNexusState> {
    const code = input.stateCode.toUpperCase();
    const existing = await db
      .select()
      .from(orgNexusStates)
      .where(and(eq(orgNexusStates.orgId, currentOrgId()), eq(orgNexusStates.stateCode, code)))
      .then((r: any[]) => r[0]);
    if (existing) throw new Error(`Nexus for ${code} already exists`);
    const row = await db
      .insert(orgNexusStates)
      .values({
        orgId: currentOrgId(),
        stateCode: code,
        registrationNumber: input.registrationNumber ?? null,
        effectiveDate: input.effectiveDate ?? null,
        createdAt: nowIso(),
      })
      .returning().then((r) => r[0]);
    await this.audit("create", "nexus_state", row.id, `Added sales-tax nexus: ${code}`);
    return row;
  }
  async deleteNexusState(id: number) {
    const existing = await db
      .select()
      .from(orgNexusStates)
      .where(and(eq(orgNexusStates.id, id), eq(orgNexusStates.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!existing) throw new Error("Nexus state not found");
    await db.delete(orgNexusStates)
      .where(and(eq(orgNexusStates.id, id), eq(orgNexusStates.orgId, currentOrgId())))
      ;
    await this.audit("delete", "nexus_state", id, `Removed sales-tax nexus: ${existing.stateCode}`);
  }

  // Context needed for a TaxJar calculation on behalf of the active org:
  // ship-from address + nexus list + a manual fallback rate (first tax code, or
  // the explicitly requested one).
  async taxCalculationContext(taxCodeId?: number): Promise<{
    fromZip?: string; fromState?: string; fromCity?: string;
    nexusStates: string[];
    fallback?: { rate: number; label?: string };
  }> {
    const org = await db.select().from(organizations).where(eq(organizations.id, currentOrgId())).then((r: any[]) => r[0]);
    const nexus = (await this.listNexusStates()).map((n) => n.stateCode);
    let fallback: { rate: number; label?: string } | undefined;
    if (taxCodeId) {
      const code = await this.getTaxCode(taxCodeId);
      if (code) fallback = { rate: code.rate, label: code.name };
    } else {
      const first = (await this.listTaxCodes()).find((c) => c.isActive);
      if (first) fallback = { rate: first.rate, label: first.name };
    }
    return {
      fromZip: org?.addressZip ?? undefined,
      fromState: org?.addressState ?? undefined,
      fromCity: org?.addressCity ?? undefined,
      nexusStates: nexus,
      fallback,
    };
  }

  // Async wrapper around createInvoice(): computes tax via TaxJar FIRST (async),
  // then runs the synchronous better-sqlite3 transaction with the result.
  // Falls back to the plain manual path whenever automation can't apply — it
  // NEVER throws because of TaxJar (rule: don't block invoice creation).
  async createInvoiceWithAutoTax(input: CreateInvoiceInput): Promise<Invoice> {
    const cust = await this.getCustomer(input.customerId);
    const ctx = await this.taxCalculationContext(input.taxCodeId);

    const canAutoCalc =
      taxjarConfigured() &&
      !!cust?.shippingZip &&
      !!cust?.shippingState &&
      !!ctx.fromZip &&
      !!ctx.fromState;

    if (!canAutoCalc) {
      if (taxjarConfigured() && cust && (!cust.shippingZip || !cust.shippingState)) {
        logger.warn("[taxjar] customer has no shipping ZIP/state — using manual tax", { invoice: input.number ?? "(auto)", customer: cust.name });
      }
      if (taxjarConfigured() && (!ctx.fromZip || !ctx.fromState)) {
        logger.warn("[taxjar] organization has no ship-from address configured — using manual tax", { invoice: input.number ?? "(auto)" });
      }
      return await this.createInvoice(input);
    }

    // Same per-line rounding as createInvoice so the taxable base matches exactly.
    // Per-line integer cents — identical formula to createInvoice, so the
    // TaxJar base always matches what gets stored on the invoice.
    const amountCents = input.lines
      .map((l) => Math.round(l.quantity * l.rate * 100))
      .reduce((a, b) => a + b, 0);

    let calc: CalculateSalesTaxResult;
    try {
      calc = await calculateSalesTax({
        fromZip: ctx.fromZip!,
        fromState: ctx.fromState!,
        fromCity: ctx.fromCity,
        toZip: cust!.shippingZip!,
        toState: cust!.shippingState!,
        toCity: cust!.shippingCity ?? undefined,
        amount: amountCents,
        nexusStates: ctx.nexusStates,
        fallback: ctx.fallback,
      });
    } catch (e: any) {
      // calculateSalesTax only throws on invalid input (bad state code etc.) —
      // API failures already fall back internally. Still: never block the invoice.
      logger.warn("[taxjar] calculation error; using manual tax", { invoice: input.number ?? "(auto)", error: e?.message });
      return await this.createInvoice(input);
    }

    const breakdownJson = JSON.stringify({
      source: calc.source,
      taxRate: calc.taxRate,
      taxAmountCents: calc.taxAmount,
      breakdownCents: calc.breakdown,
      warning: calc.warning,
      raw: calc.raw ?? null, // verbatim TaxJar response for audit
      calculatedAt: new Date().toISOString(),
      toAddress: { zip: cust!.shippingZip, state: cust!.shippingState, city: cust!.shippingCity },
    });

    return await this.createInvoice(input, {
      taxOverride: {
        taxCents: calc.taxAmount, // already integer cents from calculateSalesTax
        ratePercent: calc.taxRate,
        breakdownJson,
      },
    });
  }

  async taxLiabilityReport(asOfDate?: string) {
    const codes = await this.listTaxCodes();
    const taxSums = async (accountId: number): Promise<{ cr: number; dr: number }> => {
      const q = `SELECT COALESCE(SUM(jl.credit),0) as cr, COALESCE(SUM(jl.debit),0) as dr
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           WHERE jl.account_id = $1 ${asOfDate ? "AND je.date <= $2" : ""}`;
      const { rows } = await pool.query(q, asOfDate ? [accountId, asOfDate] : [accountId]);
      return rows[0];
    };
    const result: Array<{ taxCodeId: number; name: string; rate: number; agency: string | null; collected: number }> = [];
    for (const c of codes) {
      const sums = await taxSums(c.liabilityAccountId);
      const collected = (sums.cr - sums.dr); // credit-normal
      result.push({
        taxCodeId: c.id,
        name: c.name,
        rate: c.rate,
        agency: c.agency,
        collected,
      });
    }
    // Reconcile to the GL: tax posted with an ad-hoc rate (no tax code) credits
    // the default Sales Tax Payable account (2100) but belongs to no code — the
    // report must still show it, or it silently understates what is owed.
    const coveredAccountIds = new Set(codes.map((c) => c.liabilityAccountId));
    const defaultTaxAcct = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, "2100"), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (defaultTaxAcct && !coveredAccountIds.has(defaultTaxAcct.id)) {
      const sums = await taxSums(defaultTaxAcct.id);
      const collected = (sums.cr - sums.dr);
      if (collected !== 0) {
        result.push({
          taxCodeId: 0,
          name: "Uncategorized sales tax (ad-hoc rates → 2100)",
          rate: 0,
          agency: null as any,
          collected,
        });
      }
    }
    return { asOfDate: asOfDate ?? new Date().toISOString().slice(0, 10), rows: result };
  }

  // ============================================================================
  // 1099 SUMMARY — cash paid to 1099-tracked vendors in a calendar year
  // ============================================================================
  // 1099s are CASH-basis: we sum actual payments (A/P debits on payment journal
  // entries) dated within the year, grouped by vendor via the bill number the
  // payment references — the exact linkage the vendor statement uses. Only
  // vendors flagged track_1099 are considered; `rows` lists those at or above
  // the reporting threshold (default $600 for 1099-NEC), and `belowThreshold`
  // reports tracked vendors that fell short so the UI can still show them.
  async report1099Summary(
    year: number,
    thresholdCents = 60000,
  ): Promise<{
    year: number;
    thresholdCents: number;
    rows: Array<{ vendorId: number; name: string; taxId: string | null; paidCents: number; missingTaxId: boolean }>;
    belowThreshold: Array<{ vendorId: number; name: string; taxId: string | null; paidCents: number }>;
  }> {
    const org = currentOrgId();
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const { rows } = await pool.query(
      `SELECT v.id AS vendor_id, v.name, v.tax_id,
              COALESCE(SUM(jl.debit), 0)::bigint AS paid_cents
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN accounts ap      ON ap.id = jl.account_id AND ap.code = '2000' AND ap.org_id = $1
         JOIN bills b          ON b.number = je.reference AND b.org_id = $1
         JOIN vendors v        ON v.id = b.vendor_id AND v.org_id = $1
        WHERE je.org_id = $1
          AND je.source IN ('payment', 'bill_payment')
          AND je.date >= $2 AND je.date <= $3
          AND v.track_1099 = true
          AND jl.debit > 0
        GROUP BY v.id, v.name, v.tax_id
        ORDER BY paid_cents DESC`,
      [org, start, end],
    );
    const all = rows.map((r: any) => ({
      vendorId: r.vendor_id as number,
      name: r.name as string,
      taxId: (r.tax_id ?? null) as string | null,
      paidCents: Number(r.paid_cents),
    }));
    return {
      year,
      thresholdCents,
      rows: all
        .filter((r) => r.paidCents >= thresholdCents)
        .map((r) => ({ ...r, missingTaxId: !r.taxId })),
      belowThreshold: all.filter((r) => r.paidCents < thresholdCents),
    };
  }

  // ============================================================================
  // SPRINT C: GLOBAL SEARCH
  // ============================================================================
  async globalSearch(q: string, limit = 30) {
    const term = `%${q.toLowerCase()}%`;
    const out: Array<{
      kind: string;
      id: number;
      title: string;
      subtitle?: string;
      amount?: number;
      date?: string;
      url: string;
    }> = [];

    if (q.trim().length < 1) return out;
    const orgId = currentOrgId();

    // Customers
    const cust = (await pool.query(`SELECT id, name, email FROM customers WHERE org_id = $1 AND (LOWER(name) LIKE $2 OR LOWER(COALESCE(email,'')) LIKE $3) LIMIT $4`, [orgId, term, term, limit])).rows as any[];
    for (const c of cust) out.push({ kind: "customer", id: c.id, title: c.name, subtitle: c.email || "Customer", url: `/customers` });

    // Vendors
    const ven = (await pool.query(`SELECT id, name, email FROM vendors WHERE org_id = $1 AND (LOWER(name) LIKE $2 OR LOWER(COALESCE(email,'')) LIKE $3) LIMIT $4`, [orgId, term, term, limit])).rows as any[];
    for (const v of ven) out.push({ kind: "vendor", id: v.id, title: v.name, subtitle: v.email || "Vendor", url: `/vendors` });

    // Accounts
    const accs = (await pool.query(`SELECT id, code, name, type FROM accounts WHERE org_id = $1 AND (LOWER(name) LIKE $2 OR code LIKE $3) LIMIT $4`, [orgId, term, term, limit])).rows as any[];
    for (const a of accs)
      out.push({
        kind: "account",
        id: a.id,
        title: `${a.code} · ${a.name}`,
        subtitle: a.type,
        url: `/accounts`,
      });

    // Invoices (by number, customer name, memo, amount)
    const invs = (await pool.query(`SELECT i.id, i.number, i.date, i.total, i.status, c.name as customer
         FROM invoices i JOIN customers c ON c.id = i.customer_id
         WHERE i.org_id = $1 AND (LOWER(i.number) LIKE $2 OR LOWER(c.name) LIKE $3 OR LOWER(COALESCE(i.notes,'')) LIKE $4
            OR CAST(i.total AS TEXT) LIKE $5)
         ORDER BY i.date DESC LIMIT $6`, [orgId, term, term, term, term, limit])).rows as any[];
    for (const i of invs)
      out.push({
        kind: "invoice",
        id: i.id,
        title: `${i.number} · ${i.customer}`,
        subtitle: `${i.status.toUpperCase()} · ${i.date}`,
        amount: i.total,
        date: i.date,
        url: `/invoices`,
      });

    // Bills
    const bils = (await pool.query(`SELECT b.id, b.number, b.date, b.total, b.status, v.name as vendor
         FROM bills b JOIN vendors v ON v.id = b.vendor_id
         WHERE b.org_id = $1 AND (LOWER(b.number) LIKE $2 OR LOWER(v.name) LIKE $3 OR LOWER(COALESCE(b.notes,'')) LIKE $4
            OR CAST(b.total AS TEXT) LIKE $5)
         ORDER BY b.date DESC LIMIT $6`, [orgId, term, term, term, term, limit])).rows as any[];
    for (const b of bils)
      out.push({
        kind: "bill",
        id: b.id,
        title: `${b.number} · ${b.vendor}`,
        subtitle: `${b.status.toUpperCase()} · ${b.date}`,
        amount: b.total,
        date: b.date,
        url: `/bills`,
      });

    // Journal entries
    const jes = (await pool.query(`SELECT id, date, memo, reference FROM journal_entries
         WHERE org_id = $1 AND (LOWER(COALESCE(memo,'')) LIKE $2 OR LOWER(COALESCE(reference,'')) LIKE $3)
         ORDER BY date DESC, id DESC LIMIT $4`, [orgId, term, term, limit])).rows as any[];
    for (const j of jes)
      out.push({
        kind: "journal",
        id: j.id,
        title: j.memo || `JE #${j.id}`,
        subtitle: `Journal · ${j.date}${j.reference ? " · " + j.reference : ""}`,
        date: j.date,
        url: `/journal`,
      });

    // Bank transactions
    const bts = (await pool.query(`SELECT id, date, description, amount, status FROM bank_transactions
         WHERE org_id = $1 AND (LOWER(description) LIKE $2 OR CAST(amount AS TEXT) LIKE $3)
         ORDER BY date DESC LIMIT $4`, [orgId, term, term, limit])).rows as any[];
    for (const t of bts)
      out.push({
        kind: "bank",
        id: t.id,
        title: t.description,
        subtitle: `${t.status.toUpperCase()} · ${t.date}`,
        amount: t.amount,
        date: t.date,
        url: `/banking`,
      });

    return out.slice(0, limit * 2);
  }

  // ============================================================================
  // SPRINT C: INVOICE SHARES
  // ============================================================================
  async listSharesForInvoice(invoiceId: number): Promise<InvoiceShare[]> {
    return await db.select().from(invoiceShares).where(eq(invoiceShares.invoiceId, invoiceId)).orderBy(desc(invoiceShares.id));
  }
  // Default expiry: 90 days. Tokens are public-internet URLs, so an indefinite lifetime
  // is a security smell. Callers can override with `expiresInDays`.
  async createInvoiceShare(invoiceId: number, recipientEmail?: string, expiresInDays = 90): Promise<InvoiceShare> {
    const inv = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!inv) throw new Error("Invoice not found");
    if (expiresInDays < 1 || expiresInDays > 3650) {
      throw new Error("expiresInDays must be between 1 and 3650");
    }
    const token = crypto.randomBytes(24).toString("base64url");
    const exp = new Date();
    exp.setUTCDate(exp.getUTCDate() + expiresInDays);
    const row = await db
      .insert(invoiceShares)
      .values({
          orgId: currentOrgId(),
        invoiceId,
        token,
        recipientEmail: recipientEmail ?? null,
        expiresAt: exp.toISOString(),
        createdAt: nowIso(),
      })
      .returning().then((r) => r[0]);
    await this.audit("share", "invoice", invoiceId, `Share token created (expires ${exp.toISOString().slice(0, 10)})`);
    return row;
  }

  // Look up by token. Returns undefined if not found, expired, or revoked.
  async getShareByToken(token: string): Promise<(InvoiceShare & { invoice?: any; customer?: any; lines?: any[] }) | undefined> {
    const share = await db.select().from(invoiceShares).where(eq(invoiceShares.token, token)).then((r: any[]) => r[0]);
    if (!share) return undefined;
    if (share.revokedAt) return undefined;
    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) return undefined;
    // Public share pages run outside any session — resolve the invoice inside
    // the share row's own org context (the token itself is the authorization).
    const inv = await withOrg({ orgId: share.orgId, userId: 0 }, () => this.getInvoice(share.invoiceId));
    return { ...share, invoice: inv, customer: inv?.customer, lines: inv?.lines };
  }

  async revokeInvoiceShare(id: number): Promise<InvoiceShare> {
    const share = await db
      .select()
      .from(invoiceShares)
      .where(and(eq(invoiceShares.id, id), eq(invoiceShares.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!share) throw new Error("Share not found");
    if (share.revokedAt) return share; // idempotent
    const updated = await db
      .update(invoiceShares)
      .set({ revokedAt: nowIso() })
      .where(eq(invoiceShares.id, id))
      .returning().then((r) => r[0]);
    await this.audit("revoke", "invoice_share", id, `Revoked share token for invoice ${share.invoiceId}`);
    return updated;
  }
  async recordShareView(token: string) {
    const share = await db.select().from(invoiceShares).where(eq(invoiceShares.token, token)).then((r: any[]) => r[0]);
    if (!share) return;
    await db.update(invoiceShares)
      .set({
        viewedAt: new Date().toISOString(),
        viewCount: share.viewCount + 1,
      })
      .where(eq(invoiceShares.id, share.id))
      ;
  }
  async markShareSent(id: number, status: "sent" | "failed", error?: string) {
    await db.update(invoiceShares)
      .set({
        sentAt: new Date().toISOString(),
        emailStatus: status,
        emailError: error ?? null,
      })
      .where(eq(invoiceShares.id, id))
      ;
  }

  // ---------- Accounts ----------
  async listAccounts(): Promise<Account[]> {
    return await db.select().from(accounts).where(eq(accounts.orgId, currentOrgId())).orderBy(accounts.code);
  }
  async getAccount(id: number): Promise<Account | undefined> {
    return await db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async createAccount(data: InsertAccount): Promise<Account> {
    // Code uniqueness is enforced at the DB level (UNIQUE index), but surface a nicer error.
    const byCode = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, data.code), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (byCode) throw new Error(`An account with code "${data.code}" already exists ("${byCode.name}").`);
    // Name uniqueness is a soft constraint — confusing duplicates harm UX. Block at the API.
    const byName = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.name, data.name), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (byName) throw new Error(`An account named "${data.name}" already exists (code ${byName.code}).`);
    return await db.insert(accounts).values({ ...data, orgId: currentOrgId() }).returning().then((r) => r[0]);
  }
  async updateAccount(id: number, data: Partial<InsertAccount>): Promise<Account | undefined> {
    // Once an account has been used in journal entries, do NOT allow changing its
    // type, code, or subtype — that would silently corrupt every report retroactively.
    // (Subtype drives cash flow classification: e.g. flipping 'fixed_asset' → 'current_asset'
    // moves the account from the Investing section to Operating without any audit trail.)
    const existing = await this.getAccount(id);
    if (!existing) return undefined;
    const used = (await pool.query(`SELECT COUNT(*) AS c FROM journal_lines WHERE account_id = $1`, [id])).rows[0] as { c: number };
    if (used.c > 0) {
      if (data.type !== undefined && data.type !== existing.type) {
        throw new Error(
          `Cannot change type of "${existing.name}" — it has ${used.c} journal line(s). Create a new account and reclassify instead.`
        );
      }
      if (data.code !== undefined && data.code !== existing.code) {
        throw new Error(
          `Cannot change code of "${existing.name}" — it has ${used.c} journal line(s). Code is referenced by tooling and reports.`
        );
      }
      if (data.subtype !== undefined && data.subtype !== existing.subtype) {
        throw new Error(
          `Cannot change subtype of "${existing.name}" — it has ${used.c} journal line(s). Subtype affects cash-flow classification; use Reclassify to move lines to a new account instead.`
        );
      }
    }
    return db
      .update(accounts)
      .set(data)
      .where(and(eq(accounts.id, id), eq(accounts.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
  }

  // ---------- Customers ----------
  async listCustomers(limit = 50, offset = 0): Promise<Paginated<Customer>> {
    const where = eq(customers.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(customers).where(where);
    const rows = await db.select().from(customers).where(where).orderBy(customers.name).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }
  async createCustomer(data: InsertCustomer, opts: { force?: boolean } = {}): Promise<Customer> {
    // Duplicate-name detection (BUG-006): block a same-name customer (case-
    // insensitive, same org) unless the caller explicitly forces it. The 409
    // carries the existing record's id so the client can offer
    // "use existing / create anyway".
    if (!opts.force) {
      const existing = await db
        .select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(and(eq(customers.orgId, currentOrgId()), sql`lower(${customers.name}) = lower(${data.name})`))
        .limit(1)
        .then((r: any[]) => r[0]);
      if (existing) {
        const err: any = new Error(`A customer named "${existing.name}" already exists. Use the existing one, or resubmit with force to create a duplicate.`);
        err.httpStatus = 409;
        err.existing = { id: existing.id, name: existing.name };
        throw err;
      }
    }
    return await db.insert(customers).values({ ...data, orgId: currentOrgId() }).returning().then((r) => r[0]);
  }
  async getCustomer(id: number): Promise<Customer | undefined> {
    return await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async deleteCustomer(id: number) {
    const existing = await this.getCustomer(id);
    if (!existing) throw new Error("Customer not found");
    // Block deletion if any invoices reference this customer — would orphan ledger history.
    const refCount = (await pool.query(`SELECT COUNT(*) AS c FROM invoices WHERE customer_id = $1`, [id])).rows[0] as { c: number };
    if (refCount.c > 0) {
      throw new Error(
        `Cannot delete: customer is referenced by ${refCount.c} invoice(s). Void/delete those first or mark the customer inactive instead.`
      );
    }
    return await db.delete(customers).where(and(eq(customers.id, id), eq(customers.orgId, currentOrgId())));
  }
  async updateCustomer(id: number, data: Partial<InsertCustomer>): Promise<Customer | undefined> {
    const existing = await this.getCustomer(id);
    if (!existing) return undefined;
    return db
      .update(customers)
      .set(data)
      .where(and(eq(customers.id, id), eq(customers.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
  }

  // ---------- Vendors ----------
  async listVendors(limit = 50, offset = 0): Promise<Paginated<Vendor>> {
    const where = eq(vendors.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(vendors).where(where);
    const rows = await db.select().from(vendors).where(where).orderBy(vendors.name).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }
  async createVendor(data: InsertVendor, opts: { force?: boolean } = {}): Promise<Vendor> {
    // Duplicate-name detection (BUG-006): mirror createCustomer.
    if (!opts.force) {
      const existing = await db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.orgId, currentOrgId()), sql`lower(${vendors.name}) = lower(${data.name})`))
        .limit(1)
        .then((r: any[]) => r[0]);
      if (existing) {
        const err: any = new Error(`A vendor named "${existing.name}" already exists. Use the existing one, or resubmit with force to create a duplicate.`);
        err.httpStatus = 409;
        err.existing = { id: existing.id, name: existing.name };
        throw err;
      }
    }
    return await db.insert(vendors).values({ ...data, orgId: currentOrgId() }).returning().then((r) => r[0]);
  }
  async getVendor(id: number): Promise<Vendor | undefined> {
    return await db.select().from(vendors).where(and(eq(vendors.id, id), eq(vendors.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async deleteVendor(id: number) {
    const existing = await this.getVendor(id);
    if (!existing) throw new Error("Vendor not found");
    const refCount = (await pool.query(`SELECT COUNT(*) AS c FROM bills WHERE vendor_id = $1`, [id])).rows[0] as { c: number };
    if (refCount.c > 0) {
      throw new Error(
        `Cannot delete: vendor is referenced by ${refCount.c} bill(s). Void/delete those first or mark the vendor inactive instead.`
      );
    }
    return await db.delete(vendors).where(and(eq(vendors.id, id), eq(vendors.orgId, currentOrgId())));
  }
  async updateVendor(id: number, data: Partial<InsertVendor>): Promise<Vendor | undefined> {
    const existing = await this.getVendor(id);
    if (!existing) return undefined;
    return db
      .update(vendors)
      .set(data)
      .where(and(eq(vendors.id, id), eq(vendors.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
  }

  // ---------- Dimensions: classes & locations ----------
  async listClasses(includeInactive = true): Promise<Class[]> {
    const where = includeInactive
      ? eq(classes.orgId, currentOrgId())
      : and(eq(classes.orgId, currentOrgId()), eq(classes.isActive, true));
    return await db.select().from(classes).where(where).orderBy(classes.name);
  }
  async createClass(data: InsertClass): Promise<Class> {
    return await db.insert(classes).values({ ...data, orgId: currentOrgId() }).returning().then((r) => r[0]);
  }
  async updateClass(id: number, data: Partial<InsertClass>): Promise<Class | undefined> {
    return db.update(classes).set(data)
      .where(and(eq(classes.id, id), eq(classes.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
  }
  async listLocations(includeInactive = true): Promise<Location[]> {
    const where = includeInactive
      ? eq(locations.orgId, currentOrgId())
      : and(eq(locations.orgId, currentOrgId()), eq(locations.isActive, true));
    return await db.select().from(locations).where(where).orderBy(locations.name);
  }
  async createLocation(data: InsertLocation): Promise<Location> {
    return await db.insert(locations).values({ ...data, orgId: currentOrgId() }).returning().then((r) => r[0]);
  }
  async updateLocation(id: number, data: Partial<InsertLocation>): Promise<Location | undefined> {
    return db.update(locations).set(data)
      .where(and(eq(locations.id, id), eq(locations.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
  }
  // ---------- Dimensions: projects (jobs) ----------
  async listProjects(includeInactive = true): Promise<Project[]> {
    const where = includeInactive
      ? eq(projects.orgId, currentOrgId())
      : and(eq(projects.orgId, currentOrgId()), eq(projects.isActive, true));
    return await db.select().from(projects).where(where).orderBy(projects.name);
  }
  async createProject(data: InsertProject): Promise<Project> {
    // If tied to a customer, the customer must belong to this org.
    if (data.customerId != null) {
      const cust = await this.getCustomer(data.customerId);
      if (!cust) throw new Error(`Customer #${data.customerId} not found in this organization`);
    }
    return await db.insert(projects).values({ ...data, orgId: currentOrgId() }).returning().then((r) => r[0]);
  }
  async updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined> {
    if (data.customerId != null) {
      const cust = await this.getCustomer(data.customerId);
      if (!cust) throw new Error(`Customer #${data.customerId} not found in this organization`);
    }
    return db.update(projects).set(data)
      .where(and(eq(projects.id, id), eq(projects.orgId, currentOrgId())))
      .returning().then((r) => r[0]);
  }
  // Validate that every referenced class/location/project id exists in THIS org.
  // Nulls and undefineds are ignored (dimensions are optional). Cheap: at most
  // three membership queries, only when dimensions are actually used.
  private async assertDimensions(
    classIds: Array<number | null | undefined>,
    locationIds: Array<number | null | undefined>,
    projectIds: Array<number | null | undefined> = [],
  ): Promise<void> {
    const check = async (ids: Array<number | null | undefined>, table: typeof classes | typeof locations | typeof projects, label: string) => {
      const uniq = [...new Set(ids.filter((v): v is number => typeof v === "number"))];
      if (uniq.length === 0) return;
      const found = await db.select({ id: table.id }).from(table)
        .where(and(inArray(table.id, uniq), eq(table.orgId, currentOrgId())));
      const foundIds = new Set(found.map((r) => r.id));
      const missing = uniq.filter((id) => !foundIds.has(id));
      if (missing.length > 0) throw new Error(`Unknown ${label} id(s) for this organization: ${missing.join(", ")}`);
    };
    await check(classIds, classes, "class");
    await check(locationIds, locations, "location");
    await check(projectIds, projects, "project");
  }

  // ---------- Items / Inventory ----------
  // Internal: load the items referenced by a set of line itemIds, org-scoped,
  // validating each exists in THIS org and is active. Returns them keyed by id.
  private async loadItemsForLines(itemIds: number[]): Promise<Map<number, Item>> {
    const uniq = [...new Set(itemIds)];
    if (uniq.length === 0) return new Map();
    const rows = await db.select().from(items).where(and(inArray(items.id, uniq), eq(items.orgId, currentOrgId())));
    const map = new Map(rows.map((r) => [r.id, r]));
    for (const id of uniq) {
      const it = map.get(id);
      if (!it) throw new Error(`Item ${id} not found in this organization.`);
      if (!it.isActive) throw new Error(`Item "${it.sku}" is inactive and cannot be used on new documents.`);
    }
    return map;
  }

  // Internal: this org's negative-stock policy (organizations is a global table,
  // scoped here by id === currentOrgId()).
  private async orgAllowsNegativeStock(): Promise<boolean> {
    const row = await db
      .select({ v: organizations.allowNegativeStock })
      .from(organizations)
      .where(eq(organizations.id, currentOrgId()))
      .then((r: any[]) => r[0]);
    return !!row?.v;
  }

  // Internal: this org's inventory costing method. FIFO/LIFO maintain cost
  // layers; anything else (default) uses the weighted average.
  private async orgCostingMethod(): Promise<"average" | "fifo" | "lifo"> {
    const row = await db
      .select({ v: organizations.costingMethod })
      .from(organizations)
      .where(eq(organizations.id, currentOrgId()))
      .then((r: any[]) => r[0]);
    return row?.v === "fifo" || row?.v === "lifo" ? row.v : "average";
  }

  // Internal: validate that the GL accounts an item points at exist in this org
  // and have the expected normal type (income/expense/asset).
  private async assertItemAccounts(data: {
    type?: string;
    salesAccountId?: number;
    expenseAccountId?: number;
    inventoryAssetAccountId?: number | null;
    cogsAccountId?: number;
  }): Promise<void> {
    const all = await this.listAccounts();
    const byId = new Map(all.map((a) => [a.id, a]));
    const need = (id: number | undefined | null, label: string, wantType?: string) => {
      if (id === undefined || id === null) return;
      const a = byId.get(id);
      if (!a) throw new Error(`${label} account ${id} does not exist in this organization.`);
      if (wantType && a.type !== wantType) {
        throw new Error(`${label} account "${a.code} ${a.name}" must be of type ${wantType}.`);
      }
    };
    need(data.salesAccountId, "Sales", "income");
    need(data.expenseAccountId, "Expense", "expense");
    need(data.cogsAccountId, "COGS", "expense");
    need(data.inventoryAssetAccountId ?? undefined, "Inventory asset", "asset");
  }

  async listItems(limit = 50, offset = 0): Promise<Paginated<Item>> {
    const where = eq(items.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(items).where(where);
    const rows = await db.select().from(items).where(where).orderBy(items.sku).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }

  async getItem(id: number): Promise<Item | undefined> {
    return await db.select().from(items).where(and(eq(items.id, id), eq(items.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }

  async createItem(data: InsertItem): Promise<Item> {
    // Per-org SKU uniqueness (DB enforces UNIQUE(org_id, sku); nicer error here).
    const bySku = await db.select().from(items).where(and(eq(items.sku, data.sku), eq(items.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (bySku) throw new Error(`An item with SKU "${data.sku}" already exists ("${bySku.name}").`);
    await this.assertItemAccounts(data);
    // quantity_on_hand / avg_cost_cents start at zero and are only ever moved by
    // inventory_movements — never seeded from the request body.
    const row = await db.insert(items).values({
      ...data,
      orgId: currentOrgId(),
      inventoryAssetAccountId: data.inventoryAssetAccountId ?? null,
      quantityOnHand: 0,
      avgCostCents: 0,
      updatedAt: nowIso(),
    }).returning().then((r) => r[0]);
    await this.audit("create", "item", row.id, `Created ${row.type} item ${row.sku} — ${row.name}`);
    return row;
  }

  async updateItem(id: number, data: UpdateItem): Promise<Item | undefined> {
    const existing = await this.getItem(id);
    if (!existing) return undefined;
    const effectiveType = data.type ?? existing.type;
    const effectiveInvAsset = data.inventoryAssetAccountId ?? existing.inventoryAssetAccountId;
    if (effectiveType === "inventory" && !effectiveInvAsset) {
      throw new Error("Inventory items require an inventoryAssetAccountId.");
    }
    // Once stock has moved, freeze the type and the inventory asset account —
    // changing either would strand quantity_on_hand against a different GL
    // account and break the valuation tie-out.
    const moved = (await pool.query(`SELECT COUNT(*)::int AS c FROM inventory_movements WHERE item_id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0] as { c: number };
    if (moved.c > 0) {
      if (data.type !== undefined && data.type !== existing.type) {
        throw new Error(`Cannot change the type of "${existing.sku}" — it has ${moved.c} stock movement(s).`);
      }
      if (data.inventoryAssetAccountId !== undefined && data.inventoryAssetAccountId !== existing.inventoryAssetAccountId) {
        throw new Error(`Cannot change the inventory asset account of "${existing.sku}" — it has ${moved.c} stock movement(s).`);
      }
    }
    await this.assertItemAccounts({ ...data, type: effectiveType });
    const row = await db.update(items).set({ ...data, updatedAt: nowIso() }).where(and(eq(items.id, id), eq(items.orgId, currentOrgId()))).returning().then((r) => r[0]);
    await this.audit("update", "item", id, `Updated item ${existing.sku}`);
    return row;
  }

  async deleteItem(id: number): Promise<{ ok: true }> {
    const existing = await this.getItem(id);
    if (!existing) throw new Error("Item not found");
    const moved = (await pool.query(`SELECT COUNT(*)::int AS c FROM inventory_movements WHERE item_id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0] as { c: number };
    if (moved.c > 0) {
      throw new Error(`Cannot delete "${existing.sku}" — it has ${moved.c} stock movement(s). Mark it inactive instead.`);
    }
    await db.delete(items).where(and(eq(items.id, id), eq(items.orgId, currentOrgId())));
    await this.audit("delete", "item", id, `Deleted item ${existing.sku}`);
    return { ok: true };
  }

  // Stock-valuation report: sum(quantity_on_hand * avg_cost_cents) per inventory
  // item, tied out to the Inventory Asset GL balance(s). Mirrors the A/R aging
  // self-check — a divergence surfaces as a warning rather than a hard error,
  // since it means the GL was touched outside the purchase/sale workflow.
  async inventoryValuation(asOfDate?: string) {
    const rowsRaw = await db
      .select()
      .from(items)
      .where(and(eq(items.orgId, currentOrgId()), eq(items.type, "inventory")));
    const rows = rowsRaw
      .map((it) => ({
        id: it.id,
        sku: it.sku,
        name: it.name,
        quantityOnHand: it.quantityOnHand,
        avgCostCents: it.avgCostCents,
        valuationCents: it.quantityOnHand * it.avgCostCents,
        inventoryAssetAccountId: it.inventoryAssetAccountId,
        isActive: it.isActive,
      }))
      .sort((a, b) => b.valuationCents - a.valuationCents);
    // FIFO/LIFO: value each item from its remaining cost layers (sum of
    // cost_remaining_cents), which ties to the Inventory Asset GL exactly.
    const costingMethod = await this.orgCostingMethod();
    if (costingMethod !== "average") {
      const layerSums = await db
        .select({ itemId: inventoryLayers.itemId, cost: sql<number>`COALESCE(SUM(${inventoryLayers.costRemainingCents}), 0)` })
        .from(inventoryLayers)
        .where(eq(inventoryLayers.orgId, currentOrgId()))
        .groupBy(inventoryLayers.itemId);
      const byItem = new Map(layerSums.map((r: any) => [r.itemId, Number(r.cost)]));
      for (const r of rows) {
        r.valuationCents = byItem.get(r.id) ?? 0;
        r.avgCostCents = r.quantityOnHand > 0 ? Math.round(r.valuationCents / r.quantityOnHand) : 0;
      }
      rows.sort((a, b) => b.valuationCents - a.valuationCents);
    }
    const totalValuationCents = rows.reduce((s, r) => s + r.valuationCents, 0);

    // Tie-out: sum the GL balances of the DISTINCT inventory asset accounts these
    // items capitalize into.
    const balances = await this.accountBalances(asOfDate);
    const all = await this.listAccounts();
    const acctMap = new Map(all.map((a) => [a.id, a]));
    const assetAccountIds = [...new Set(rows.map((r) => r.inventoryAssetAccountId).filter((x): x is number => x != null))];
    const glAccounts = assetAccountIds.map((accountId) => ({
      accountId,
      code: acctMap.get(accountId)?.code ?? null,
      name: acctMap.get(accountId)?.name ?? null,
      glBalance: balances.get(accountId)?.balance ?? 0,
    }));
    const glTotal = glAccounts.reduce((s, a) => s + a.glBalance, 0);
    const diff = totalValuationCents - glTotal;
    let warning: string | undefined;
    if (diff !== 0) {
      warning =
        `Inventory valuation (${formatMoney(totalValuationCents)}) does not match the Inventory Asset GL balance (${formatMoney(glTotal)}). ` +
        `Difference: ${formatMoney(diff)}. This usually means a journal entry was posted directly to an inventory account, ` +
        `or negative stock was sold — reconcile before relying on the balance sheet.`;
    }
    return {
      asOfDate: asOfDate ?? new Date().toISOString().slice(0, 10),
      costingMethod,
      rows,
      totalValuationCents,
      glAccounts,
      glTotal,
      warning,
    };
  }

  // Open FIFO/LIFO cost layers for one item (empty under the average method),
  // in consumption order — oldest-first for FIFO, newest-first for LIFO — so the
  // UI can show which lots will be relieved on the next sale.
  async listItemCostLayers(itemId: number): Promise<{ costingMethod: string; layers: Array<{ id: number; date: string; qtyRemaining: number; costRemainingCents: number; unitCostCents: number }> }> {
    const method = await this.orgCostingMethod();
    if (method === "average") return { costingMethod: method, layers: [] };
    const rows = await db.select().from(inventoryLayers)
      .where(and(eq(inventoryLayers.itemId, itemId), eq(inventoryLayers.orgId, currentOrgId()), gt(inventoryLayers.qtyRemaining, 0)))
      .orderBy(
        method === "lifo" ? desc(inventoryLayers.date) : inventoryLayers.date,
        method === "lifo" ? desc(inventoryLayers.id) : inventoryLayers.id,
      );
    return {
      costingMethod: method,
      layers: rows.map((r: any) => ({
        id: r.id, date: r.date, qtyRemaining: r.qtyRemaining,
        costRemainingCents: Number(r.costRemainingCents), unitCostCents: Number(r.unitCostCents),
      })),
    };
  }

  // ---------- Purchase Orders ----------
  // A PO is an AP commitment: it posts NO journal entry. Receiving it (below)
  // creates a bill for the received portion, which is where the GL effect and
  // any inventory movements happen.
  async listPurchaseOrders(limit = 50, offset = 0): Promise<Paginated<PurchaseOrder & { vendorName?: string }>> {
    const where = eq(purchaseOrders.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` })
      .from(purchaseOrders).innerJoin(vendors, eq(purchaseOrders.vendorId, vendors.id)).where(where);
    const rows = await db.select({ po: purchaseOrders, vendor: vendors })
      .from(purchaseOrders).innerJoin(vendors, eq(purchaseOrders.vendorId, vendors.id))
      .where(where).orderBy(desc(purchaseOrders.date), desc(purchaseOrders.id)).limit(limit).offset(offset);
    return { rows: rows.map((r) => ({ ...r.po, vendorName: r.vendor.name })), total, limit, offset };
  }

  async getPurchaseOrder(id: number): Promise<(PurchaseOrder & { lines: PurchaseOrderLine[]; vendor?: Vendor }) | undefined> {
    const po = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!po) return undefined;
    const lines = await db.select().from(purchaseOrderLines)
      .where(and(eq(purchaseOrderLines.poId, id), eq(purchaseOrderLines.orgId, currentOrgId())))
      .orderBy(purchaseOrderLines.id);
    const vendor = await db.select().from(vendors).where(and(eq(vendors.id, po.vendorId), eq(vendors.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    return { ...po, lines, vendor };
  }

  // Resolve the GL debit account for a PO/receipt line: an item line derives it
  // (inventory → Inventory Asset; otherwise → the item's expense account); a
  // plain line names its own expense account.
  private resolvePoLineAccount(line: { itemId?: number; expenseAccountId?: number }, itemMap: Map<number, Item>): number {
    if (line.itemId !== undefined) {
      const it = itemMap.get(line.itemId)!;
      return it.type === "inventory" ? it.inventoryAssetAccountId! : it.expenseAccountId;
    }
    if (line.expenseAccountId !== undefined) return line.expenseAccountId;
    throw new Error("Purchase order line requires itemId or expenseAccountId");
  }

  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    const poNumber: string = input.number ?? await this.nextNumber("purchase_order");
    const itemMap = await this.loadItemsForLines(input.lines.filter((l) => l.itemId !== undefined).map((l) => l.itemId as number));
    const resolvedExpense: number[] = input.lines.map((l) => this.resolvePoLineAccount(l, itemMap));
    const fx = await this.resolveDocumentFx(input.currency, input.fxRate);
    try {
      return await db.transaction(async (tx) => {
        const po = await tx.insert(purchaseOrders).values({
          orgId: currentOrgId(), number: poNumber, vendorId: input.vendorId, date: input.date,
          expectedDate: input.expectedDate ?? null, status: "open",
          currency: fx?.currency ?? "", fxRate: fx?.fxRate ?? 1, notes: input.notes ?? null, updatedAt: nowIso(),
        }).returning().then((r) => r[0]);
        for (let idx = 0; idx < input.lines.length; idx++) {
          const l = input.lines[idx];
          await tx.insert(purchaseOrderLines).values({
            orgId: currentOrgId(), poId: po.id, description: l.description, quantity: l.quantity, rate: l.rate,
            amountCents: Math.round(l.quantity * l.rate * 100), expenseAccountId: resolvedExpense[idx],
            itemId: l.itemId ?? null, qtyReceived: 0,
          });
        }
        // NO journal entry — a PO is a commitment, not a GL event.
        await this.audit("create", "purchase_order", po.id, `Created purchase order ${poNumber} (${input.lines.length} line(s))`);
        return po;
      });
    } catch (err: any) {
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        throw new Error(`Purchase order number "${poNumber}" already exists in this organization.`);
      }
      throw err;
    }
  }

  async updatePurchaseOrder(id: number, input: UpdatePurchaseOrderInput): Promise<PurchaseOrder | undefined> {
    const existing = await this.getPurchaseOrder(id);
    if (!existing) return undefined;
    if (existing.status === "cancelled") throw new Error("A cancelled purchase order cannot be edited.");
    const anyReceived = existing.lines.some((l) => l.qtyReceived > 0);
    if (input.status === "cancelled" && anyReceived) {
      throw new Error("Cannot cancel a purchase order that has already been (partly) received.");
    }
    if (input.lines && (existing.status !== "open" || anyReceived)) {
      throw new Error("Purchase order lines can only be edited before anything is received.");
    }
    const fx = (input.currency !== undefined || input.fxRate !== undefined)
      ? await this.resolveDocumentFx(input.currency ?? (existing.currency || undefined), input.fxRate ?? existing.fxRate)
      : null;
    const itemMap = input.lines
      ? await this.loadItemsForLines(input.lines.filter((l) => l.itemId !== undefined).map((l) => l.itemId as number))
      : new Map<number, Item>();
    return await db.transaction(async (tx) => {
      const patch: any = { updatedAt: nowIso() };
      if (input.vendorId !== undefined) patch.vendorId = input.vendorId;
      if (input.date !== undefined) patch.date = input.date;
      if (input.expectedDate !== undefined) patch.expectedDate = input.expectedDate;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.status !== undefined) patch.status = input.status;
      if (fx) { patch.currency = fx.currency; patch.fxRate = fx.fxRate; }
      if (input.lines) {
        await tx.delete(purchaseOrderLines).where(and(eq(purchaseOrderLines.poId, id), eq(purchaseOrderLines.orgId, currentOrgId())));
        for (const l of input.lines) {
          await tx.insert(purchaseOrderLines).values({
            orgId: currentOrgId(), poId: id, description: l.description, quantity: l.quantity, rate: l.rate,
            amountCents: Math.round(l.quantity * l.rate * 100), expenseAccountId: this.resolvePoLineAccount(l, itemMap),
            itemId: l.itemId ?? null, qtyReceived: 0,
          });
        }
      }
      const po = await tx.update(purchaseOrders).set(patch)
        .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.orgId, currentOrgId()))).returning().then((r) => r[0]);
      await this.audit("update", "purchase_order", id, `Updated purchase order ${existing.number}`);
      return po;
    });
  }

  async deletePurchaseOrder(id: number): Promise<{ ok: true }> {
    const existing = await this.getPurchaseOrder(id);
    if (!existing) throw new Error("Purchase order not found");
    if (existing.lines.some((l) => l.qtyReceived > 0)) {
      throw new Error(`Cannot delete purchase order ${existing.number} — it has received lines. Cancel or close it instead.`);
    }
    await db.transaction(async (tx) => {
      await tx.delete(purchaseOrderLines).where(and(eq(purchaseOrderLines.poId, id), eq(purchaseOrderLines.orgId, currentOrgId())));
      await tx.delete(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.orgId, currentOrgId())));
    });
    await this.audit("delete", "purchase_order", id, `Deleted purchase order ${existing.number}`);
    return { ok: true };
  }

  // Receive a PO (fully or partially). Builds a bill for ONLY the received
  // portion via createBill() INSIDE ONE transaction, bumps qty_received, and
  // moves the PO to 'partial' or 'received'. Over-receipt is rejected. If a
  // received line links an inventory item, createBill records the inventory
  // movement (MF-1) as part of the same atomic unit.
  async receivePurchaseOrder(id: number, input: ReceivePurchaseOrderInput): Promise<{ purchaseOrder: PurchaseOrder; bill: Bill }> {
    const po = await this.getPurchaseOrder(id);
    if (!po) throw new Error("Purchase order not found");
    if (po.status === "cancelled" || po.status === "closed") {
      throw new Error(`Purchase order ${po.number} is ${po.status} and cannot receive more.`);
    }
    const lineById = new Map(po.lines.map((l) => [l.id, l]));
    const receipts: { line: PurchaseOrderLine; qty: number }[] = [];
    for (const r of input.lines) {
      const line = lineById.get(r.poLineId);
      if (!line) throw new Error(`Line ${r.poLineId} is not part of purchase order ${po.number}.`);
      const remaining = line.quantity - line.qtyReceived;
      if (r.quantity > remaining) {
        throw new Error(`Over-receipt on "${line.description}": receiving ${r.quantity} but only ${remaining} of ${line.quantity} remain (already received ${line.qtyReceived}).`);
      }
      receipts.push({ line, qty: r.quantity });
    }
    const dueDate = input.dueDate ?? input.date;

    const bill = await db.transaction(async (tx) => {
      const billInput = {
        vendorId: po.vendorId,
        date: input.date,
        dueDate,
        taxRate: 0,
        currency: po.currency || undefined,
        fxRate: po.currency ? po.fxRate : undefined,
        lines: receipts.map((rc) => ({
          description: rc.line.description,
          quantity: rc.qty,
          rate: rc.line.rate,
          itemId: rc.line.itemId ?? undefined,
          expenseAccountId: rc.line.itemId ? undefined : rc.line.expenseAccountId,
        })),
      } as CreateBillInput;
      // createBill joins THIS transaction via _tx, so the bill, its JE, and any
      // inventory movements commit atomically with the PO updates below.
      const b = await this.createBill(billInput, { _tx: tx });
      await tx.update(bills).set({ poId: po.id }).where(and(eq(bills.id, b.id), eq(bills.orgId, currentOrgId())));

      for (const rc of receipts) {
        await tx.update(purchaseOrderLines).set({ qtyReceived: rc.line.qtyReceived + rc.qty })
          .where(and(eq(purchaseOrderLines.id, rc.line.id), eq(purchaseOrderLines.orgId, currentOrgId())));
      }
      const receivedNow = new Map(receipts.map((rc) => [rc.line.id, rc.line.qtyReceived + rc.qty]));
      const fullyReceived = po.lines.every((l) => (receivedNow.get(l.id) ?? l.qtyReceived) >= l.quantity);
      const newStatus = fullyReceived ? "received" : "partial";
      await tx.update(purchaseOrders).set({ status: newStatus, updatedAt: nowIso() })
        .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.orgId, currentOrgId())));
      await this.audit("receive", "purchase_order", po.id, `Received purchase order ${po.number} → bill ${b.number} (${newStatus})`);
      return { ...b, poId: po.id } as Bill;
    });
    // bill.created webhook fires AFTER commit (createBill deferred it under _tx).
    await emitWebhookEvent("bill.created", { id: bill.id, number: bill.number, total: bill.total, currency: bill.currency || null });
    const updated = (await this.getPurchaseOrder(id))!;
    return { purchaseOrder: updated, bill };
  }

  // ---------- Estimates (quotes) ----------
  // An estimate is a QUOTE: it posts NO GL entry. Converting it runs through
  // createInvoice() (reusing its rounding + tax + GL math). The stored *_cents
  // are a snapshot computed with the same per-line formula so the converted
  // invoice's totals match the estimate exactly.
  async listEstimates(limit = 50, offset = 0): Promise<Paginated<Estimate & { customerName?: string }>> {
    const where = eq(estimates.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` })
      .from(estimates).innerJoin(customers, eq(estimates.customerId, customers.id)).where(where);
    const rows = await db.select({ est: estimates, customer: customers })
      .from(estimates).innerJoin(customers, eq(estimates.customerId, customers.id))
      .where(where).orderBy(desc(estimates.date), desc(estimates.id)).limit(limit).offset(offset);
    return { rows: rows.map((r) => ({ ...r.est, customerName: r.customer.name })), total, limit, offset };
  }

  async getEstimate(id: number): Promise<(Estimate & { lines: EstimateLine[]; customer?: Customer }) | undefined> {
    const est = await db.select().from(estimates).where(and(eq(estimates.id, id), eq(estimates.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!est) return undefined;
    const lines = await db.select().from(estimateLines)
      .where(and(eq(estimateLines.estimateId, id), eq(estimateLines.orgId, currentOrgId())))
      .orderBy(estimateLines.id);
    const customer = await db.select().from(customers).where(and(eq(customers.id, est.customerId), eq(customers.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    return { ...est, lines, customer };
  }

  async createEstimate(input: CreateEstimateInput): Promise<Estimate> {
    const estNumber: string = input.number ?? await this.nextNumber("estimate");
    // Income account is DERIVED from the item when present (never from the body).
    const itemMap = await this.loadItemsForLines(input.lines.filter((l) => l.itemId !== undefined).map((l) => l.itemId as number));
    const resolvedIncome: number[] = input.lines.map((l) => {
      if (l.itemId !== undefined) return itemMap.get(l.itemId)!.salesAccountId;
      if (l.incomeAccountId !== undefined) return l.incomeAccountId;
      throw new Error("Estimate line requires itemId or incomeAccountId");
    });
    // Snapshot totals in the DOCUMENT currency using the SAME per-line rounding
    // + tax formula createInvoice uses, so a later conversion reproduces them.
    let effectiveRate = input.taxRate;
    if (input.taxCodeId) {
      const code = await this.getTaxCode(input.taxCodeId);
      if (!code) throw new Error("Tax code not found");
      effectiveRate = code.rate;
    }
    const fx = await this.resolveDocumentFx(input.currency, input.fxRate);
    const lineAmounts: number[] = input.lines.map((l) => Math.round(l.quantity * l.rate * 100)); // document-currency cents
    const subtotalCents = lineAmounts.reduce((s, a) => s + a, 0);
    const taxCents = Math.round((subtotalCents * effectiveRate) / 100);
    const totalCents = subtotalCents + taxCents;
    try {
      return await db.transaction(async (tx) => {
        const est = await tx.insert(estimates).values({
          orgId: currentOrgId(), number: estNumber, customerId: input.customerId,
          date: input.date, expiryDate: input.expiryDate, status: "draft",
          currency: fx?.currency ?? "", fxRate: fx?.fxRate ?? 1,
          subtotalCents, taxCents, totalCents, notes: input.notes ?? null, updatedAt: nowIso(),
        }).returning().then((r: any[]) => r[0]);
        for (let idx = 0; idx < input.lines.length; idx++) {
          const l = input.lines[idx];
          await tx.insert(estimateLines).values({
            orgId: currentOrgId(), estimateId: est.id, description: l.description,
            quantity: l.quantity, rate: l.rate, amount: lineAmounts[idx],
            incomeAccountId: resolvedIncome[idx], itemId: l.itemId ?? null,
          });
        }
        // NO journal entry — an estimate is a quote, not a GL event.
        await this.audit("create", "estimate", est.id, `Created estimate ${estNumber} (${formatMoney(totalCents)})`);
        return est;
      });
    } catch (err: any) {
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        throw new Error(`Estimate number "${estNumber}" already exists in this organization.`);
      }
      throw err;
    }
  }

  async updateEstimate(id: number, input: UpdateEstimateInput): Promise<Estimate | undefined> {
    const existing = await this.getEstimate(id);
    if (!existing) return undefined;
    if (existing.status === "invoiced") throw new Error("A converted estimate can no longer be edited.");
    const patch: any = { updatedAt: nowIso() };
    if (input.customerId !== undefined) patch.customerId = input.customerId;
    if (input.date !== undefined) patch.date = input.date;
    if (input.expiryDate !== undefined) patch.expiryDate = input.expiryDate;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.status !== undefined) patch.status = input.status;
    const est = await db.update(estimates).set(patch)
      .where(and(eq(estimates.id, id), eq(estimates.orgId, currentOrgId()))).returning().then((r: any[]) => r[0]);
    await this.audit("update", "estimate", id, `Updated estimate ${existing.number}`);
    return est;
  }

  async deleteEstimate(id: number): Promise<{ ok: true }> {
    const existing = await this.getEstimate(id);
    if (!existing) throw new Error("Estimate not found");
    if (existing.status === "invoiced") throw new Error(`Estimate ${existing.number} has been converted to an invoice and cannot be deleted.`);
    await db.transaction(async (tx) => {
      await tx.delete(estimateLines).where(and(eq(estimateLines.estimateId, id), eq(estimateLines.orgId, currentOrgId())));
      await tx.delete(estimateShares).where(and(eq(estimateShares.estimateId, id), eq(estimateShares.orgId, currentOrgId())));
      await tx.delete(estimates).where(and(eq(estimates.id, id), eq(estimates.orgId, currentOrgId())));
    });
    await this.audit("delete", "estimate", id, `Deleted estimate ${existing.number}`);
    return { ok: true };
  }

  // Convert an estimate into an invoice via createInvoice() (reusing its per-line
  // rounding + tax + GL logic — no math duplicated). The estimate's exact tax is
  // passed through as a taxOverride so the invoice totals equal the estimate's.
  // Everything (invoice + JE + link + status flip) commits in ONE transaction.
  async convertEstimate(id: number, input: ConvertEstimateInput): Promise<{ estimate: Estimate; invoice: Invoice }> {
    const est = await this.getEstimate(id);
    if (!est) throw new Error("Estimate not found");
    if (est.status === "invoiced") throw new Error(`Estimate ${est.number} has already been converted to an invoice.`);
    if (est.status === "expired") throw new Error(`Estimate ${est.number} has expired and cannot be converted. Re-issue it first.`);
    if (est.status === "declined") throw new Error(`Estimate ${est.number} was declined and cannot be converted.`);

    const date = input.date ?? new Date().toISOString().slice(0, 10);
    const dueDate = input.dueDate ?? (() => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })();

    const invoice = await db.transaction(async (tx) => {
      const invInput = {
        customerId: est.customerId,
        date,
        dueDate,
        notes: est.notes ?? undefined,
        currency: est.currency || undefined,
        fxRate: est.currency ? est.fxRate : undefined,
        taxRate: 0, // the estimate's exact tax is applied via taxOverride below
        lines: est.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          itemId: l.itemId ?? undefined,
          incomeAccountId: l.itemId ? undefined : l.incomeAccountId,
        })),
      } as CreateInvoiceInput;
      const inv = await this.createInvoice(invInput, {
        _tx: tx,
        taxOverride: { taxCents: est.taxCents, ratePercent: 0, breakdownJson: JSON.stringify({ source: "estimate", estimateId: est.id }) },
      });
      await tx.update(invoices).set({ estimateId: est.id }).where(and(eq(invoices.id, inv.id), eq(invoices.orgId, currentOrgId())));
      await tx.update(estimates).set({ status: "invoiced", updatedAt: nowIso() }).where(and(eq(estimates.id, est.id), eq(estimates.orgId, currentOrgId())));
      await this.audit("convert", "estimate", est.id, `Converted estimate ${est.number} → invoice ${inv.number}`);
      return { ...inv, estimateId: est.id } as Invoice;
    });
    await emitWebhookEvent("invoice.created", { id: invoice.id, number: invoice.number, total: invoice.total, currency: invoice.currency || null });
    const updated = (await this.getEstimate(id))!;
    return { estimate: updated, invoice };
  }

  // Daily-style sweep (reuses the recurring catch-up pattern): flip past-expiry
  // draft/sent estimates to 'expired' across ALL orgs, each in its own context.
  async expireEstimates(asOfDate?: string): Promise<number> {
    const today = asOfDate || new Date().toISOString().slice(0, 10);
    // Cross-org boot-time sweep (allowlisted in the org-scope guard, like runCatchUp).
    const due = await db.select().from(estimates)
      .where(and(inArray(estimates.status, ["draft", "sent"]), lte(estimates.expiryDate, today)));
    let expired = 0;
    for (const e of due) {
      if (e.expiryDate >= today) continue; // expiry_date < today ⇒ strictly past (today is still valid)
      await withOrg({ orgId: e.orgId, userId: 0 }, async () => {
        await db.update(estimates).set({ status: "expired", updatedAt: nowIso() })
          .where(and(eq(estimates.id, e.id), eq(estimates.orgId, e.orgId)));
        await this.audit("expire", "estimate", e.id, `Estimate ${e.number} expired (expiry ${e.expiryDate})`);
      });
      expired++;
    }
    return expired;
  }

  // ---------- Estimate share tokens (mirror invoice shares) ----------
  async createEstimateShare(estimateId: number, recipientEmail?: string, expiresInDays = 90): Promise<EstimateShare> {
    const est = await db.select().from(estimates).where(and(eq(estimates.id, estimateId), eq(estimates.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!est) throw new Error("Estimate not found");
    if (expiresInDays < 1 || expiresInDays > 3650) throw new Error("expiresInDays must be between 1 and 3650");
    const token = crypto.randomBytes(24).toString("base64url");
    const exp = new Date();
    exp.setUTCDate(exp.getUTCDate() + expiresInDays);
    const row = await db.insert(estimateShares).values({
      orgId: currentOrgId(), estimateId, token, recipientEmail: recipientEmail ?? null,
      expiresAt: exp.toISOString(), createdAt: nowIso(),
    }).returning().then((r: any[]) => r[0]);
    await this.audit("share", "estimate", estimateId, `Share token created (expires ${exp.toISOString().slice(0, 10)})`);
    return row;
  }

  async getEstimateShareByToken(token: string): Promise<(EstimateShare & { estimate?: any; customer?: any; lines?: any[] }) | undefined> {
    const share = await db.select().from(estimateShares).where(eq(estimateShares.token, token)).then((r: any[]) => r[0]);
    if (!share) return undefined;
    if (share.revokedAt) return undefined;
    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) return undefined;
    // Public share page runs outside any session — the unguessable token IS the
    // authorization; resolve the estimate inside the share row's own org.
    const est = await withOrg({ orgId: share.orgId, userId: 0 }, () => this.getEstimate(share.estimateId));
    return { ...share, estimate: est, customer: est?.customer, lines: est?.lines };
  }

  async recordEstimateShareView(token: string) {
    const share = await db.select().from(estimateShares).where(eq(estimateShares.token, token)).then((r: any[]) => r[0]);
    if (!share) return;
    await db.update(estimateShares)
      .set({ viewedAt: new Date().toISOString(), viewCount: share.viewCount + 1 })
      .where(eq(estimateShares.id, share.id));
  }

  // ---------- Fixed Assets & Depreciation ----------
  // A fixed asset capitalizes a purchase and depreciates over a useful life.
  // The schedule (shared/depreciation.ts) is integer cents with the last period
  // absorbing the remainder, so total depreciation exactly equals cost - salvage.
  // Monthly posting is idempotent via UNIQUE(org_id, asset_id, period).
  private async assertAssetAccounts(data: { assetAccountId?: number; accumDepAccountId?: number; depreciationExpenseAccountId?: number }): Promise<void> {
    const all = await this.listAccounts();
    const byId = new Map(all.map((a) => [a.id, a]));
    const need = (id: number | undefined, label: string, wantType: string) => {
      if (id === undefined) return;
      const a = byId.get(id);
      if (!a) throw new Error(`${label} account ${id} does not exist in this organization.`);
      if (a.type !== wantType) throw new Error(`${label} account "${a.code} ${a.name}" must be of type ${wantType}.`);
    };
    need(data.assetAccountId, "Asset", "asset");
    need(data.accumDepAccountId, "Accumulated depreciation", "asset"); // contra-asset is still type asset
    need(data.depreciationExpenseAccountId, "Depreciation expense", "expense");
  }

  private scheduleFor(asset: FixedAsset): DepreciationPeriod[] {
    return computeDepreciationSchedule({
      costCents: asset.costCents,
      salvageCents: asset.salvageCents,
      usefulLifeMonths: asset.usefulLifeMonths,
      method: asset.method as any,
      acquisitionDate: asset.acquisitionDate,
    });
  }

  private async getDepreciationEntry(assetId: number, period: string): Promise<DepreciationEntry | undefined> {
    return await db.select().from(depreciationEntries)
      .where(and(eq(depreciationEntries.assetId, assetId), eq(depreciationEntries.period, period), eq(depreciationEntries.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
  }

  private async listDepreciationEntries(assetId: number): Promise<DepreciationEntry[]> {
    return await db.select().from(depreciationEntries)
      .where(and(eq(depreciationEntries.assetId, assetId), eq(depreciationEntries.orgId, currentOrgId())))
      .orderBy(depreciationEntries.period);
  }

  private async accumulatedDepreciation(assetId: number): Promise<number> {
    const rows = await this.listDepreciationEntries(assetId);
    return rows.reduce((s, r) => s + r.amountCents, 0);
  }

  async listFixedAssets(limit = 50, offset = 0): Promise<Paginated<FixedAsset>> {
    const where = eq(fixedAssets.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(fixedAssets).where(where);
    const rows = await db.select().from(fixedAssets).where(where).orderBy(desc(fixedAssets.acquisitionDate), desc(fixedAssets.id)).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }

  async getFixedAsset(id: number): Promise<FixedAsset | undefined> {
    return await db.select().from(fixedAssets).where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }

  // Asset detail with its full schedule, per-period posted status, accumulated
  // depreciation and current net book value.
  async getFixedAssetDetail(id: number) {
    const asset = await this.getFixedAsset(id);
    if (!asset) return undefined;
    const schedule = this.scheduleFor(asset);
    const posted = await this.listDepreciationEntries(id);
    const byPeriod = new Map(posted.map((p) => [p.period, p]));
    const accumulatedDepreciationCents = posted.reduce((s, p) => s + p.amountCents, 0);
    return {
      ...asset,
      accumulatedDepreciationCents,
      netBookValueCents: asset.costCents - accumulatedDepreciationCents,
      schedule: schedule.map((p) => ({ ...p, posted: byPeriod.has(p.period), entryId: byPeriod.get(p.period)?.entryId ?? null })),
    };
  }

  async createFixedAsset(input: CreateFixedAssetInput): Promise<FixedAsset> {
    await this.assertAssetAccounts(input);
    const row = await db.insert(fixedAssets).values({
      orgId: currentOrgId(),
      name: input.name,
      assetAccountId: input.assetAccountId,
      accumDepAccountId: input.accumDepAccountId,
      depreciationExpenseAccountId: input.depreciationExpenseAccountId,
      acquisitionDate: input.acquisitionDate,
      costCents: input.costCents,
      salvageCents: input.salvageCents,
      usefulLifeMonths: input.usefulLifeMonths,
      method: input.method,
      status: "active",
      updatedAt: nowIso(),
    }).returning().then((r: any[]) => r[0]);
    await this.audit("create", "fixed_asset", row.id, `Registered fixed asset "${row.name}" (${formatMoney(row.costCents)}, ${row.usefulLifeMonths}mo ${row.method})`);
    return row;
  }

  async updateFixedAsset(id: number, input: UpdateFixedAssetInput): Promise<FixedAsset | undefined> {
    const existing = await this.getFixedAsset(id);
    if (!existing) return undefined;
    if (existing.status === "disposed") throw new Error(`Asset "${existing.name}" is disposed and cannot be edited.`);
    // Once any depreciation has posted, freeze the inputs that define the schedule.
    const postedCount = (await pool.query(`SELECT COUNT(*)::int AS c FROM depreciation_entries WHERE asset_id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0].c as number;
    if (postedCount > 0) {
      for (const f of ["costCents", "salvageCents", "usefulLifeMonths", "method", "acquisitionDate"] as const) {
        if (input[f] !== undefined && input[f] !== (existing as any)[f]) {
          throw new Error(`Cannot change ${f} of "${existing.name}" — depreciation has already been posted. Reverse those entries first.`);
        }
      }
    }
    await this.assertAssetAccounts({
      assetAccountId: input.assetAccountId ?? existing.assetAccountId,
      accumDepAccountId: input.accumDepAccountId ?? existing.accumDepAccountId,
      depreciationExpenseAccountId: input.depreciationExpenseAccountId ?? existing.depreciationExpenseAccountId,
    });
    const patch: any = { updatedAt: nowIso() };
    for (const k of ["name", "assetAccountId", "accumDepAccountId", "depreciationExpenseAccountId", "acquisitionDate", "costCents", "salvageCents", "usefulLifeMonths", "method"] as const) {
      if (input[k] !== undefined) patch[k] = input[k];
    }
    const row = await db.update(fixedAssets).set(patch).where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, currentOrgId()))).returning().then((r: any[]) => r[0]);
    await this.audit("update", "fixed_asset", id, `Updated fixed asset "${existing.name}"`);
    return row;
  }

  async deleteFixedAsset(id: number): Promise<{ ok: true }> {
    const existing = await this.getFixedAsset(id);
    if (!existing) throw new Error("Fixed asset not found");
    const postedCount = (await pool.query(`SELECT COUNT(*)::int AS c FROM depreciation_entries WHERE asset_id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0].c as number;
    if (postedCount > 0) throw new Error(`Cannot delete "${existing.name}" — it has ${postedCount} depreciation posting(s). Dispose it instead.`);
    await db.delete(fixedAssets).where(and(eq(fixedAssets.id, id), eq(fixedAssets.orgId, currentOrgId())));
    await this.audit("delete", "fixed_asset", id, `Deleted fixed asset "${existing.name}"`);
    return { ok: true };
  }

  // Post one period's depreciation: Dr Depreciation Expense / Cr Accumulated
  // Depreciation. Idempotent — a period already posted is a no-op (the UNIQUE
  // constraint also guards against a concurrent double-post). Respects period
  // locks (via postJournalEntry). A zero-amount period is recorded with no JE.
  async postDepreciation(assetId: number, period: string): Promise<{ entry: DepreciationEntry; posted: boolean; amountCents: number }> {
    const asset = await this.getFixedAsset(assetId);
    if (!asset) throw new Error("Fixed asset not found");
    if (asset.status === "disposed") throw new Error(`Asset "${asset.name}" is disposed; no further depreciation can be posted.`);
    const schedule = this.scheduleFor(asset);
    const sched = schedule.find((p) => p.period === period);
    if (!sched) {
      throw new Error(`${period} is outside the depreciation schedule for "${asset.name}" (${schedule[0].period} – ${schedule[schedule.length - 1].period}).`);
    }
    const already = await this.getDepreciationEntry(assetId, period);
    if (already) return { entry: already, posted: false, amountCents: already.amountCents };

    const amount = sched.amountCents;
    const jeDate = lastDayOfPeriod(period);
    try {
      const row = await db.transaction(async (tx) => {
        let entryId: number | null = null;
        if (amount > 0) {
          const je = await this.postJournalEntry({
            date: jeDate,
            memo: `Depreciation — ${asset.name} (${period})`,
            reference: `DEP-${asset.id}-${period}`,
            source: "depreciation",
            sourceId: asset.id,
            lines: [
              { accountId: asset.depreciationExpenseAccountId, debit: amount, credit: 0, description: `Depreciation ${period}` },
              { accountId: asset.accumDepAccountId, debit: 0, credit: amount, description: `Accumulated depreciation ${period}` },
            ],
          }, { _tx: tx });
          entryId = je.entry.id;
        }
        const inserted = await tx.insert(depreciationEntries).values({
          orgId: currentOrgId(), assetId: asset.id, period, amountCents: amount, entryId, createdAt: nowIso(),
        }).returning().then((r: any[]) => r[0]);
        await this.audit("post", "depreciation", asset.id, `Posted depreciation for "${asset.name}" ${period} (${formatMoney(amount)})`, { period, amountCents: amount });
        return inserted as DepreciationEntry;
      });
      // Flip to fully_depreciated once accumulated reaches cost - salvage.
      const accumulated = await this.accumulatedDepreciation(assetId);
      if (asset.status === "active" && accumulated >= asset.costCents - asset.salvageCents) {
        await db.update(fixedAssets).set({ status: "fully_depreciated", updatedAt: nowIso() })
          .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.orgId, currentOrgId())));
      }
      return { entry: row, posted: true, amountCents: amount };
    } catch (err: any) {
      // Lost a race against a concurrent post — the winner's row stands; no-op.
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        const e = await this.getDepreciationEntry(assetId, period);
        if (e) return { entry: e, posted: false, amountCents: e.amountCents };
      }
      throw err;
    }
  }

  // Boot-time depreciation catch-up (reuses the recurring catch-up cross-org
  // pattern): for every active asset, post any scheduled period up to the current
  // month that has not been posted yet. Idempotent, so restarting the server
  // safely backfills missed months; a locked period is skipped, not fatal.
  async runDepreciationCatchUp(asOfDate?: string): Promise<number> {
    const today = asOfDate || new Date().toISOString().slice(0, 10);
    const currentPeriod = periodOf(today);
    // Cross-org sweep (allowlisted in the org-scope guard, like runCatchUp).
    const assets = await db.select().from(fixedAssets).where(eq(fixedAssets.status, "active"));
    let posted = 0;
    for (const a of assets) {
      await withOrg({ orgId: a.orgId, userId: 0 }, async () => {
        const schedule = this.scheduleFor(a);
        for (const p of schedule) {
          if (p.period > currentPeriod) break; // future months aren't due yet
          try {
            const r = await this.postDepreciation(a.id, p.period);
            if (r.posted) posted++;
          } catch {
            // e.g. that period is locked — leave it for a later run after reopen.
          }
        }
      });
    }
    return posted;
  }

  // Dispose of an asset: remove its cost and accumulated depreciation, record any
  // proceeds, and book the gain/loss to a configurable account — one balanced JE.
  async disposeFixedAsset(assetId: number, input: DisposeFixedAssetInput): Promise<{ asset: FixedAsset; entry: JournalEntry; gainLossCents: number; netBookValueCents: number }> {
    const asset = await this.getFixedAsset(assetId);
    if (!asset) throw new Error("Fixed asset not found");
    if (asset.status === "disposed") throw new Error(`Asset "${asset.name}" is already disposed.`);
    const all = await this.listAccounts();
    const byId = new Map(all.map((a) => [a.id, a]));
    if (!byId.get(input.gainLossAccountId)) throw new Error("gainLossAccountId does not exist in this organization.");
    if (input.proceedsCents > 0 && (input.proceedsAccountId === undefined || !byId.get(input.proceedsAccountId))) {
      throw new Error("proceedsAccountId does not exist in this organization.");
    }
    const accumulated = await this.accumulatedDepreciation(assetId);
    const netBookValueCents = asset.costCents - accumulated;
    const gainLossCents = input.proceedsCents - netBookValueCents; // > 0 gain, < 0 loss

    const entry = await db.transaction(async (tx) => {
      const lines: any[] = [];
      // Remove the asset at cost (Cr the asset account).
      lines.push({ accountId: asset.assetAccountId, debit: 0, credit: asset.costCents, description: `Dispose ${asset.name}: remove cost` });
      // Clear accumulated depreciation (Dr the contra-asset).
      if (accumulated > 0) {
        lines.push({ accountId: asset.accumDepAccountId, debit: accumulated, credit: 0, description: `Dispose ${asset.name}: clear accumulated depreciation` });
      }
      // Proceeds received.
      if (input.proceedsCents > 0) {
        lines.push({ accountId: input.proceedsAccountId!, debit: input.proceedsCents, credit: 0, description: `Dispose ${asset.name}: proceeds` });
      }
      // Plug the difference to gain (credit) or loss (debit).
      if (gainLossCents > 0) {
        lines.push({ accountId: input.gainLossAccountId, debit: 0, credit: gainLossCents, description: `Gain on disposal of ${asset.name}` });
      } else if (gainLossCents < 0) {
        lines.push({ accountId: input.gainLossAccountId, debit: -gainLossCents, credit: 0, description: `Loss on disposal of ${asset.name}` });
      }
      const je = await this.postJournalEntry({
        date: input.date,
        memo: `Disposal of ${asset.name}`,
        reference: `DISP-${asset.id}`,
        source: "asset_disposal",
        sourceId: asset.id,
        lines,
      }, { _tx: tx });
      await tx.update(fixedAssets).set({ status: "disposed", disposedDate: input.date, updatedAt: nowIso() })
        .where(and(eq(fixedAssets.id, asset.id), eq(fixedAssets.orgId, currentOrgId())));
      await this.audit("dispose", "fixed_asset", asset.id,
        `Disposed "${asset.name}" (NBV ${formatMoney(netBookValueCents)}, proceeds ${formatMoney(input.proceedsCents)}, ${gainLossCents >= 0 ? "gain" : "loss"} ${formatMoney(Math.abs(gainLossCents))})`,
        { proceedsCents: input.proceedsCents, gainLossCents, netBookValueCents });
      return je.entry;
    });
    const updated = (await this.getFixedAsset(assetId))!;
    return { asset: updated, entry, gainLossCents, netBookValueCents };
  }

  // ---------- Payroll ----------
  // Idempotent per-org seeds for the payroll GL accounts (older orgs self-heal),
  // mirroring ensureFxAccounts().
  private async ensurePayrollAccounts(): Promise<{ wages: Account; taxExpense: Account; taxesPayable: Account; deductionsPayable: Account }> {
    const orgId = currentOrgId();
    const find = async (code: string) => db.select().from(accounts).where(and(eq(accounts.code, code), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    const ensure = async (code: string, name: string, type: string, subtype: string) => {
      let a = await find(code);
      if (!a) a = await db.insert(accounts).values({ orgId, code, name, type, subtype, isActive: true }).returning().then((r) => r[0]);
      return a as Account;
    };
    return {
      wages: await ensure("6300", "Salaries & Wages", "expense", "operating_expense"),
      taxExpense: await ensure("6350", "Payroll Tax Expense", "expense", "operating_expense"),
      taxesPayable: await ensure("2300", "Payroll Taxes Payable", "liability", "current_liability"),
      deductionsPayable: await ensure("2310", "Payroll Deductions Payable", "liability", "current_liability"),
    };
  }

  // Posted year-to-date gross for an employee in a calendar year (drives the
  // annual wage-base caps). Only POSTED runs count; a run being posted excludes
  // itself so it never double-counts.
  private async ytdGrossForEmployee(employeeId: number, year: string, excludeRunId?: number): Promise<number> {
    const params: any[] = [currentOrgId(), employeeId, year];
    let extra = "";
    if (excludeRunId !== undefined) { params.push(excludeRunId); extra = ` AND pr.id <> $4`; }
    const row = (await pool.query(
      `SELECT COALESCE(SUM(pi.gross_cents), 0)::bigint AS ytd
       FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.run_id
       WHERE pi.org_id = $1 AND pi.employee_id = $2 AND pr.status = 'posted' AND substr(pr.pay_date, 1, 4) = $3${extra}`,
      params
    )).rows[0];
    return Number(row?.ytd ?? 0);
  }

  async listEmployees(limit = 50, offset = 0): Promise<Paginated<Employee>> {
    const where = eq(employees.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(employees).where(where);
    const rows = await db.select().from(employees).where(where).orderBy(employees.name).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }
  async getEmployee(id: number): Promise<Employee | undefined> {
    return await db.select().from(employees).where(and(eq(employees.id, id), eq(employees.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async createEmployee(input: CreateEmployeeInput): Promise<Employee> {
    const row = await db.insert(employees).values({
      orgId: currentOrgId(), name: input.name, email: input.email || null, payType: input.payType,
      payRateCents: input.payRateCents, payFrequency: input.payFrequency,
      federalWithholdingRate: input.federalWithholdingRate, stateWithholdingRate: input.stateWithholdingRate,
      status: input.status, hireDate: input.hireDate ?? null, createdAt: nowIso(), updatedAt: nowIso(),
    }).returning().then((r: any[]) => r[0]);
    await this.audit("create", "employee", row.id, `Added employee ${row.name} (${row.payType})`);
    return row;
  }
  async updateEmployee(id: number, input: UpdateEmployeeInput): Promise<Employee | undefined> {
    const existing = await this.getEmployee(id);
    if (!existing) return undefined;
    const patch: any = { updatedAt: nowIso() };
    for (const k of ["name", "email", "payType", "payRateCents", "payFrequency", "federalWithholdingRate", "stateWithholdingRate", "status", "hireDate"] as const) {
      if (input[k] !== undefined) patch[k] = k === "email" ? (input[k] || null) : input[k];
    }
    const row = await db.update(employees).set(patch).where(and(eq(employees.id, id), eq(employees.orgId, currentOrgId()))).returning().then((r: any[]) => r[0]);
    await this.audit("update", "employee", id, `Updated employee ${existing.name}`);
    return row;
  }
  async deleteEmployee(id: number): Promise<{ ok: true }> {
    const existing = await this.getEmployee(id);
    if (!existing) throw new Error("Employee not found");
    const used = (await pool.query(`SELECT COUNT(*)::int AS c FROM payroll_items WHERE employee_id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0].c as number;
    if (used > 0) throw new Error(`Cannot delete ${existing.name} — they appear on ${used} pay run(s). Mark them inactive instead.`);
    await db.delete(employees).where(and(eq(employees.id, id), eq(employees.orgId, currentOrgId())));
    await this.audit("delete", "employee", id, `Deleted employee ${existing.name}`);
    return { ok: true };
  }

  async listPayrollRuns(limit = 50, offset = 0): Promise<Paginated<PayrollRun>> {
    const where = eq(payrollRuns.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(payrollRuns).where(where);
    const rows = await db.select().from(payrollRuns).where(where).orderBy(desc(payrollRuns.payDate), desc(payrollRuns.id)).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }
  async getPayrollRun(id: number): Promise<(PayrollRun & { items: (PayrollItem & { employeeName?: string })[] }) | undefined> {
    const run = await db.select().from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!run) return undefined;
    const items = await db.select().from(payrollItems).where(and(eq(payrollItems.runId, id), eq(payrollItems.orgId, currentOrgId()))).orderBy(payrollItems.id);
    const emps = await this.listEmployees(500, 0);
    const nameById = new Map(emps.rows.map((e) => [e.id, e.name]));
    return { ...run, items: items.map((it) => ({ ...it, employeeName: nameById.get(it.employeeId) })) };
  }

  // Gross for one run line (YTD-independent, deterministic).
  private grossForLine(emp: Employee, line: { hours?: number; additionalPayCents: number }): number {
    let base: number;
    if (emp.payType === "hourly") {
      if (line.hours === undefined) throw new Error(`Hours are required for hourly employee "${emp.name}".`);
      base = hourlyGross(emp.payRateCents, line.hours);
    } else {
      base = salaryGrossForPeriod(emp.payRateCents, emp.payFrequency as any);
    }
    return base + line.additionalPayCents;
  }

  // Create a DRAFT pay run: compute every employee's gross/taxes/net (integer
  // cents, with the current posted YTD driving wage-base caps) and store it. NO
  // journal entry — posting (below) books the GL.
  async createPayrollRun(input: CreatePayrollRunInput): Promise<PayrollRun> {
    const orgId = currentOrgId();
    const bank = await db.select().from(accounts).where(and(eq(accounts.id, input.bankAccountId), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    if (!bank) throw new Error("bankAccountId does not exist in this organization.");
    if (bank.type !== "asset") throw new Error(`Net pay must be drawn from an asset (bank) account; "${bank.code} ${bank.name}" is ${bank.type}.`);
    const year = input.payDate.slice(0, 4);
    const empIds = input.lines.map((l) => l.employeeId);
    const emps = await db.select().from(employees).where(and(inArray(employees.id, empIds), eq(employees.orgId, orgId)));
    const empMap = new Map(emps.map((e) => [e.id, e]));
    for (const id of empIds) {
      const e = empMap.get(id);
      if (!e) throw new Error(`Employee ${id} not found in this organization.`);
      if (e.status !== "active") throw new Error(`Employee "${e.name}" is inactive and cannot be paid.`);
    }

    const computed: Array<{ employeeId: number; hours: number | null; r: EmployeePayrollResult }> = [];
    const totals = { gross: 0, empTax: 0, erTax: 0, ded: 0, net: 0 };
    for (const line of input.lines) {
      const emp = empMap.get(line.employeeId)!;
      const gross = this.grossForLine(emp, line);
      const ytd = await this.ytdGrossForEmployee(emp.id, year);
      const r = computeEmployeePayroll({
        grossCents: gross, ytdGrossCents: ytd,
        preTaxCents: line.preTaxDeductionCents, postTaxCents: line.postTaxDeductionCents,
        federalWithholdingRate: emp.federalWithholdingRate, stateWithholdingRate: emp.stateWithholdingRate,
      });
      computed.push({ employeeId: emp.id, hours: emp.payType === "hourly" ? (line.hours ?? 0) : null, r });
      totals.gross += r.grossCents; totals.empTax += r.employeeTaxCents; totals.erTax += r.employerTaxCents;
      totals.ded += r.preTaxCents + r.postTaxCents; totals.net += r.netCents;
    }

    return await db.transaction(async (tx) => {
      const run = await tx.insert(payrollRuns).values({
        orgId, payDate: input.payDate, periodStart: input.periodStart, periodEnd: input.periodEnd,
        status: "draft", bankAccountId: input.bankAccountId,
        totalGrossCents: totals.gross, totalEmployeeTaxCents: totals.empTax, totalEmployerTaxCents: totals.erTax,
        totalDeductionsCents: totals.ded, totalNetCents: totals.net, createdAt: nowIso(), updatedAt: nowIso(),
      }).returning().then((r: any[]) => r[0]);
      for (const c of computed) {
        await tx.insert(payrollItems).values({ orgId, runId: run.id, employeeId: c.employeeId, hours: c.hours, ...payrollItemColumns(c.r) });
      }
      await this.audit("create", "payroll_run", run.id, `Created draft pay run ${input.periodStart}–${input.periodEnd} (${computed.length} employee(s), net ${formatMoney(totals.net)})`);
      return run;
    });
  }

  // Post a DRAFT pay run: recompute with the CURRENT posted YTD (so caps are
  // fresh if other runs posted since the draft), update the items, and book ONE
  // balanced journal entry. Respects period locks; a posted run cannot re-post.
  async postPayrollRun(id: number): Promise<PayrollRun> {
    const orgId = currentOrgId();
    const run = await db.select().from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.orgId, orgId))).then((r: any[]) => r[0]);
    if (!run) throw new Error("Pay run not found");
    if (run.status === "posted") throw new Error(`Pay run ${id} is already posted.`);
    if (run.status === "void") throw new Error(`Pay run ${id} is void.`);
    const bank = await db.select().from(accounts).where(and(eq(accounts.id, run.bankAccountId), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    if (!bank) throw new Error("The pay run's bank account no longer exists.");
    const { wages, taxExpense, taxesPayable, deductionsPayable } = await this.ensurePayrollAccounts();

    const items = await db.select().from(payrollItems).where(and(eq(payrollItems.runId, id), eq(payrollItems.orgId, orgId))).orderBy(payrollItems.id);
    const year = run.payDate.slice(0, 4);
    const computed: Array<{ id: number; r: EmployeePayrollResult }> = [];
    const totals = { gross: 0, empTax: 0, erTax: 0, ded: 0, net: 0 };
    for (const it of items) {
      const emp = await this.getEmployee(it.employeeId);
      if (!emp) throw new Error(`Employee ${it.employeeId} on this run no longer exists.`);
      const ytd = await this.ytdGrossForEmployee(emp.id, year, id); // exclude this run
      const r = computeEmployeePayroll({
        grossCents: it.grossCents, ytdGrossCents: ytd,
        preTaxCents: it.preTaxDeductionCents, postTaxCents: it.postTaxDeductionCents,
        federalWithholdingRate: emp.federalWithholdingRate, stateWithholdingRate: emp.stateWithholdingRate,
      });
      computed.push({ id: it.id, r });
      totals.gross += r.grossCents; totals.empTax += r.employeeTaxCents; totals.erTax += r.employerTaxCents;
      totals.ded += r.preTaxCents + r.postTaxCents; totals.net += r.netCents;
    }

    // Build the balanced JE: Dr Wages + Dr Payroll Tax Expense; Cr Taxes Payable,
    // Cr Deductions Payable, Cr Bank (net pay).
    const jeLines: any[] = [{ accountId: wages.id, debit: totals.gross, credit: 0, description: "Payroll — gross wages" }];
    if (totals.erTax > 0) jeLines.push({ accountId: taxExpense.id, debit: totals.erTax, credit: 0, description: "Payroll — employer taxes" });
    const taxPayable = totals.empTax + totals.erTax;
    if (taxPayable > 0) jeLines.push({ accountId: taxesPayable.id, debit: 0, credit: taxPayable, description: "Payroll — taxes payable" });
    if (totals.ded > 0) jeLines.push({ accountId: deductionsPayable.id, debit: 0, credit: totals.ded, description: "Payroll — deductions withheld" });
    if (totals.net > 0) jeLines.push({ accountId: bank.id, debit: 0, credit: totals.net, description: "Payroll — net pay" });

    return await db.transaction(async (tx) => {
      const je = await this.postJournalEntry({
        date: run.payDate,
        memo: `Payroll ${run.periodStart}–${run.periodEnd}`,
        reference: `PAY-${run.id}`,
        source: "payroll",
        sourceId: run.id,
        lines: jeLines,
      }, { _tx: tx });
      for (const c of computed) {
        await tx.update(payrollItems).set(payrollItemColumns(c.r)).where(and(eq(payrollItems.id, c.id), eq(payrollItems.orgId, orgId)));
      }
      const updated = await tx.update(payrollRuns).set({
        status: "posted", entryId: je.entry.id,
        totalGrossCents: totals.gross, totalEmployeeTaxCents: totals.empTax, totalEmployerTaxCents: totals.erTax,
        totalDeductionsCents: totals.ded, totalNetCents: totals.net, updatedAt: nowIso(),
      }).where(and(eq(payrollRuns.id, id), eq(payrollRuns.orgId, orgId))).returning().then((r: any[]) => r[0]);
      await this.audit("post", "payroll_run", id, `Posted pay run ${run.periodStart}–${run.periodEnd} (gross ${formatMoney(totals.gross)}, employer tax ${formatMoney(totals.erTax)}, net ${formatMoney(totals.net)})`);
      return updated;
    });
  }

  // Pay stub for one employee on one run: the paycheck breakdown plus inclusive
  // year-to-date figures (from posted runs up to and including this pay date).
  async getPayStub(runId: number, employeeId: number) {
    const run = await db.select().from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!run) throw new Error("Pay run not found");
    const item = await db.select().from(payrollItems)
      .where(and(eq(payrollItems.runId, runId), eq(payrollItems.employeeId, employeeId), eq(payrollItems.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!item) throw new Error("This employee is not on that pay run.");
    const employee = await this.getEmployee(employeeId);
    // Inclusive YTD from POSTED runs in the pay year, up to this pay date.
    const year = run.payDate.slice(0, 4);
    const ytd = (await pool.query(
      `SELECT COALESCE(SUM(pi.gross_cents),0)::bigint AS gross,
              COALESCE(SUM(pi.employee_tax_cents),0)::bigint AS employee_tax,
              COALESCE(SUM(pi.net_cents),0)::bigint AS net
       FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.run_id
       WHERE pi.org_id = $1 AND pi.employee_id = $2 AND pr.status = 'posted'
         AND substr(pr.pay_date,1,4) = $3 AND pr.pay_date <= $4`,
      [currentOrgId(), employeeId, year, run.payDate]
    )).rows[0];
    return {
      run: { id: run.id, payDate: run.payDate, periodStart: run.periodStart, periodEnd: run.periodEnd, status: run.status },
      employee: employee ? { id: employee.id, name: employee.name, payType: employee.payType } : { id: employeeId, name: "Employee", payType: null },
      item,
      ytd: { grossCents: Number(ytd.gross), employeeTaxCents: Number(ytd.employee_tax), netCents: Number(ytd.net) },
    };
  }

  // ---------- Pay payroll liabilities (QBO "Pay Taxes") ----------
  // What the org currently owes on its payroll-liability accounts (2300/2310).
  async payrollLiabilityBalances(asOfDate?: string): Promise<Array<{ accountId: number; code: string; name: string; balanceCents: number }>> {
    const { taxesPayable, deductionsPayable } = await this.ensurePayrollAccounts();
    const balances = await this.accountBalances(asOfDate);
    return [taxesPayable, deductionsPayable].map((a) => ({
      accountId: a.id, code: a.code, name: a.name, balanceCents: balances.get(a.id)?.balance ?? 0,
    }));
  }

  // Remit accrued payroll liabilities: Dr each liability account / Cr Bank, in
  // one balanced transaction. Respects period locks.
  async payPayrollLiabilities(input: PayPayrollLiabilitiesInput): Promise<PayrollLiabilityPayment> {
    const orgId = currentOrgId();
    const bank = await db.select().from(accounts).where(and(eq(accounts.id, input.bankAccountId), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    if (!bank) throw new Error("bankAccountId does not exist in this organization.");
    if (bank.type !== "asset") throw new Error(`Payments must be drawn from an asset (bank) account; "${bank.code} ${bank.name}" is ${bank.type}.`);
    const all = await this.listAccounts();
    const byId = new Map(all.map((a) => [a.id, a]));
    for (const l of input.lines) {
      const a = byId.get(l.accountId);
      if (!a) throw new Error(`Liability account ${l.accountId} does not exist in this organization.`);
      if (a.type !== "liability") throw new Error(`"${a.code} ${a.name}" is not a liability account and cannot be remitted here.`);
    }
    const total = input.lines.reduce((s, l) => s + l.amountCents, 0);

    return await db.transaction(async (tx) => {
      const jeLines = input.lines.map((l) => ({ accountId: l.accountId, debit: l.amountCents, credit: 0, description: `Remit ${byId.get(l.accountId)!.name}` }));
      jeLines.push({ accountId: bank.id, debit: 0, credit: total, description: "Payroll liability remittance" });
      const je = await this.postJournalEntry({
        date: input.payDate,
        memo: input.memo || `Payroll liability remittance ${input.payDate}`,
        reference: `PAYLIAB-${input.payDate}`,
        source: "payroll_liability",
        lines: jeLines,
      }, { _tx: tx });
      const payment = await tx.insert(payrollLiabilityPayments).values({
        orgId, payDate: input.payDate, bankAccountId: input.bankAccountId, entryId: je.entry.id,
        memo: input.memo ?? null, totalCents: total, createdAt: nowIso(),
      }).returning().then((r: any[]) => r[0]);
      for (const l of input.lines) {
        await tx.insert(payrollLiabilityPaymentLines).values({ orgId, paymentId: payment.id, accountId: l.accountId, amountCents: l.amountCents });
      }
      await this.audit("pay", "payroll_liability", payment.id, `Remitted payroll liabilities (${formatMoney(total)}) from ${bank.name}`);
      return payment;
    });
  }

  // ---------- Journal Entries ----------
  // Sprint C: opts.bypassLock allows the year-end close itself to post on the lock date.
  // opts._tx: optional external drizzle transaction — pass when calling from within an
  // existing db.transaction() so all writes land in ONE atomic unit (no nested savepoint).
  async postJournalEntry(input: PostJournalEntry, opts: { bypassLock?: boolean; _tx?: any; futureDateCheck?: boolean } = {}): Promise<{ entry: JournalEntry; lines: JournalLine[]; warnings?: string[] }> {
    // Future-dated guard (BUG-005) — opt-in, so ONLY user-facing manual journal
    // entries (the /api/journal route) are policed; internal system postings
    // (invoice/bill/payment/payroll/depreciation JEs) are exempt. Throws in
    // strict mode before any write; otherwise returns a warning below.
    const futureWarning = opts.futureDateCheck ? await this.checkFutureDate(input.date, "journal entry") : null;
    // FIX #10: Compute lockDate FIRST — both the condition and the error message need it.
    // The old code interpolated `this.effectiveLockDate()` (un-awaited) into the string,
    // producing "[object Promise]" in the error message and never actually comparing correctly.
    const lockDate = await this.effectiveLockDate();
    if (!opts.bypassLock && lockDate !== null && input.date <= lockDate) {
      throw new Error(
        `Cannot post on ${input.date}: that period is closed (locked through ${lockDate}). Reopen it or pick a later date.`
      );
    }
    // ---- Defense in depth: validate the entry is balanced and well-formed ----
    // This guard runs for ALL internal callers (createInvoice, payInvoice, etc.),
    // not only the /api/journal route's Zod schema. A bug in any caller that tries
    // to post unbalanced lines will throw here BEFORE any DB write.
    if (!Array.isArray(input.lines) || input.lines.length < 2) {
      throw new Error("Journal entry must have at least 2 lines (one DR + one CR).");
    }
    let totalDr = 0;
    let totalCr = 0;
    for (const l of input.lines) {
      const dr = +(l.debit || 0);
      const cr = +(l.credit || 0);
      if (dr < 0 || cr < 0) {
        throw new Error("Journal line debit/credit cannot be negative.");
      }
      if (dr > 0 && cr > 0) {
        throw new Error("A journal line cannot have both a debit and a credit.");
      }
      totalDr += dr;
      totalCr += cr;
    }
    if (totalDr <= 0) {
      throw new Error("Journal entry total must be greater than zero.");
    }
    if (totalDr !== totalCr) { // EXACT integer equality — cents never drift
      throw new Error(
        `Unbalanced journal entry: debits ${formatMoney(totalDr)} \u2260 credits ${formatMoney(totalCr)}.`
      );
    }

    // Validate any class/location dimensions referenced by the lines belong to
    // this org (defense in depth for every caller, not just the API route).
    await this.assertDimensions(
      input.lines.map((l) => (l as any).classId),
      input.lines.map((l) => (l as any).locationId),
      input.lines.map((l) => (l as any).projectId),
    );

    // FIX #15: All inserts inside the transaction callback must use `txOrDb`, not `db`.
    // When _tx is supplied by a caller already inside a transaction, we skip the outer
    // db.transaction() wrapper so all writes belong to the same transaction / connection.
    const doInserts = async (txOrDb: typeof db | any): Promise<{ entry: JournalEntry; lines: JournalLine[] }> => {
      const entry = await txOrDb
        .insert(journalEntries)
        .values({
          orgId: currentOrgId(),
          date: input.date,
          memo: input.memo,
          reference: input.reference,
          source: input.source ?? "manual",
          sourceId: input.sourceId,
        })
        .returning().then((r: any[]) => r[0]);
      const insertedLines: JournalLine[] = [];
      for (const l of input.lines) {
        const line = await txOrDb
          .insert(journalLines)
          .values({
            orgId: currentOrgId(),
            entryId: entry.id,
            accountId: l.accountId,
            debit: l.debit || 0,
            credit: l.credit || 0,
            description: l.description,
            classId: (l as any).classId ?? null,
            locationId: (l as any).locationId ?? null,
            projectId: (l as any).projectId ?? null,
          })
          .returning().then((r: any[]) => r[0]);
        insertedLines.push(line);
      }
      return { entry, lines: insertedLines };
    };

    const result = opts._tx ? await doInserts(opts._tx) : await db.transaction(doInserts);
    if (futureWarning) return { ...result, warnings: [futureWarning] };
    return result;
  }

  async listJournalEntries(
    limit = 50,
    offset = 0
  ): Promise<Paginated<JournalEntry & { lines: (JournalLine & { account?: Account })[] }>> {
    const where = eq(journalEntries.orgId, currentOrgId());
    // total from the SAME WHERE clause as the page query.
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(journalEntries).where(where);
    const entries = await db
      .select()
      .from(journalEntries)
      .where(where)
      .orderBy(desc(journalEntries.date), desc(journalEntries.id))
      .limit(limit)
      .offset(offset)
      ;
    // N+1 fix (Task 8a): ONE lines query for the whole page via inArray, grouped
    // in JS by entryId — 3 queries total (entries, lines, accounts) regardless of
    // page size, instead of 1 + N.
    const entryIds = entries.map((e) => e.id);
    const allLines = entryIds.length > 0
      ? await db.select().from(journalLines).where(inArray(journalLines.entryId, entryIds))
      : [];
    const linesByEntry = new Map<number, JournalLine[]>();
    for (const l of allLines) {
      const bucket = linesByEntry.get(l.entryId);
      if (bucket) bucket.push(l);
      else linesByEntry.set(l.entryId, [l]);
    }
    const allAccounts = await this.listAccounts();
    const acctMap = new Map(allAccounts.map((a) => [a.id, a]));
    const rows = entries.map((e) => ({
      ...e,
      lines: (linesByEntry.get(e.id) ?? []).map((l) => ({ ...l, account: acctMap.get(l.accountId) })),
    }));
    return { rows, total, limit, offset };
  }

  async getJournalLinesForAccount(accountId: number, fromDate?: string, toDate?: string) {
    // Org-scoped: accountId is caller-supplied and ids are a global sequence,
    // so filtering on the joined entry's orgId is required (caught by the
    // org-scope guard test — same class as the fixed generalLedger leak).
    const q = await db
      .select({
        line: journalLines,
        entry: journalEntries,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountId, accountId), eq(journalEntries.orgId, currentOrgId())));
    const rows = q;
    return rows.filter((r) => {
      if (fromDate && r.entry.date < fromDate) return false;
      if (toDate && r.entry.date > toDate) return false;
      return true;
    });
  }

  // ---------- Invoices ----------
  // opts._tx: optional external drizzle transaction. When supplied (e.g. by
  // convertEstimate) the invoice, its lines, its journal entry and any COGS/
  // inventory effects join the caller's transaction so everything commits or
  // rolls back atomically; the invoice.created webhook is then the caller's job.
  async createInvoice(
    input: CreateInvoiceInput,
    opts: { taxOverride?: { taxCents: number; ratePercent: number; breakdownJson: string }; _tx?: any } = {}
  ): Promise<Invoice> {
    // Auto-numbering: when the caller omits `number`, allocate the next per-org
    // value atomically. Manual override remains legal; duplicates are caught by
    // UNIQUE(org_id, number) and translated to a friendly 400 below.
    // Future-dated guard (BUG-005): throws in strict mode BEFORE any write;
    // otherwise yields a warning attached to the returned invoice below.
    const futureWarning = await this.checkFutureDate(input.date, "invoice");
    const invNumber: string = input.number ?? await this.nextNumber("invoice");
    const ar = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, "1100"), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!ar) throw new Error("Accounts Receivable account (1100) missing");

    // Resolve catalog items referenced by lines. For an item line the income
    // account is DERIVED from the item (never taken from the request). Inventory
    // items additionally relieve stock and post COGS after the sale entry below.
    const invItemMap = await this.loadItemsForLines(
      input.lines.filter((l) => l.itemId !== undefined).map((l) => l.itemId as number)
    );
    const allowNegative = await this.orgAllowsNegativeStock();
    const resolvedIncomeAccountIds: number[] = input.lines.map((l) => {
      if (l.itemId !== undefined) return invItemMap.get(l.itemId)!.salesAccountId;
      if (l.incomeAccountId !== undefined) return l.incomeAccountId;
      throw new Error("Invoice line requires itemId or incomeAccountId");
    });

    let effectiveRate = input.taxRate;
    let taxLiabAccountId: number | undefined;
    if (input.taxCodeId) {
      const code = await this.getTaxCode(input.taxCodeId);
      if (!code) throw new Error("Tax code not found");
      effectiveRate = code.rate;
      taxLiabAccountId = code.liabilityAccountId;
    } else {
      const taxLiab = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.code, "2100"), eq(accounts.orgId, currentOrgId())))
        .then((r: any[]) => r[0]);
      taxLiabAccountId = taxLiab?.id;
    }

    // ---- Bug fix: per-line rounding + tax computed from rounded subtotal ----
    // Old code stored a raw (unrounded) subtotal, then computed tax from it, which produced
    // 1-cent JE imbalances on inputs like quantity=3 × rate=33.333 because the per-line
    // amounts (used for the income credit) were rounded but the subtotal-derived debit was not.
    // Now: round every line, then sum, then compute tax — guaranteeing Dr A/R = Cr Income + Cr Tax exactly.
    // Integer cents per line: rate is a dollar unit-price input; Math.round
    // converts to exact cents once, here, and never again downstream.
    // FX resolution: null for base-currency docs. For FX docs the line math
    // below runs in FOREIGN cents; base cents = round(foreignCents * rate)
    // PER LINE, then summed — the same per-line rounding discipline as the
    // base-currency path, so the JE (posted in base) always balances exactly.
    const fx = await this.resolveDocumentFx(input.currency, input.fxRate);

    const lineAmountsRaw: number[] = input.lines.map((l) => Math.round(l.quantity * l.rate * 100));
    let lineAmounts: number[];        // BASE cents per line (drives the GL + income split)
    let foreignSubtotal = 0, foreignTax = 0, foreignTotal = 0;
    let subtotal: number, tax: number, total: number;
    if (fx) {
      const foreignLines = lineAmountsRaw;              // rates were entered in the document currency
      foreignSubtotal = foreignLines.reduce((s, a) => s + a, 0);
      foreignTax = opts.taxOverride ? opts.taxOverride.taxCents : Math.round((foreignSubtotal * effectiveRate) / 100);
      foreignTotal = foreignSubtotal + foreignTax;
      lineAmounts = foreignLines.map((a) => Math.round(a * fx.fxRate)); // base cents per line
      subtotal = lineAmounts.reduce((s, a) => s + a, 0);
      tax = Math.round(foreignTax * fx.fxRate);
      total = subtotal + tax;
    } else {
      lineAmounts = lineAmountsRaw;
      subtotal = lineAmounts.reduce((s, a) => s + a, 0); // exact integer sum
      // TaxJar path: the exact amount was computed (in cents) before entering the
      // sync transaction; use it verbatim so the ledger matches the audit record.
      tax = opts.taxOverride
        ? opts.taxOverride.taxCents // TaxJar already computes exact cents
        : Math.round((subtotal * effectiveRate) / 100); // integer cents
      total = subtotal + tax; // exact integer cents
    }

    const doCreate = async (tx: any): Promise<Invoice> => {
      const inv = await tx
        .insert(invoices)
        .values({
          orgId: currentOrgId(),
          number: invNumber,
          currency: fx?.currency ?? "",
          fxRate: fx?.fxRate ?? 1,
          foreignSubtotal,
          foreignTax,
          foreignTotal,
          foreignAmountPaid: 0,
          customerId: input.customerId,
          date: input.date,
          dueDate: input.dueDate,
          status: "open",
          subtotal,
          tax,
          total,
          amountPaid: 0,
          taxBreakdown: opts.taxOverride?.breakdownJson ?? null,
          notes: input.notes,
        })
        .returning().then((r: any[]) => r[0]);
      for (let idx = 0; idx < input.lines.length; idx++) {
        const l = input.lines[idx];
        await tx.insert(invoiceLines)
          .values({
            orgId: currentOrgId(),
            invoiceId: inv.id,
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            // FX docs: line detail lives in the DOCUMENT currency (qty × rate
            // are foreign); the GL/base view lives on the header columns.
            amount: fx ? lineAmountsRaw[idx] : lineAmounts[idx],
            incomeAccountId: resolvedIncomeAccountIds[idx],
            itemId: l.itemId ?? null,
            classId: (l as any).classId ?? null,
            locationId: (l as any).locationId ?? null,
            projectId: (l as any).projectId ?? null,
          });
      }
      // Post journal entry: Dr A/R, Cr each Income account, Cr Sales Tax Payable.
      // Group income by (account, class, location, project) so each dimension
      // combination lands on its own GL credit line — this is what makes a
      // dimension-filtered P&L accurate.
      const lines: any[] = [{ accountId: ar.id, debit: total, credit: 0, description: `Invoice ${invNumber}` }];
      const incomeMap = new Map<string, { accountId: number; classId: number | null; locationId: number | null; projectId: number | null; amt: number }>();
      input.lines.forEach((l, idx) => {
        const acctId = resolvedIncomeAccountIds[idx];
        const classId = (l as any).classId ?? null;
        const locationId = (l as any).locationId ?? null;
        const projectId = (l as any).projectId ?? null;
        const key = `${acctId}|${classId}|${locationId}|${projectId}`;
        const cur = incomeMap.get(key);
        if (cur) cur.amt += lineAmounts[idx];
        else incomeMap.set(key, { accountId: acctId, classId, locationId, projectId, amt: lineAmounts[idx] });
      });
      for (const g of incomeMap.values()) {
        lines.push({ accountId: g.accountId, debit: 0, credit: g.amt, description: `Invoice ${invNumber}`, classId: g.classId, locationId: g.locationId, projectId: g.projectId });
      }
      if (tax > 0 && taxLiabAccountId) {
        lines.push({ accountId: taxLiabAccountId, debit: 0, credit: tax, description: `Sales tax on ${invNumber}` });
      }
      await this.postJournalEntry({
        date: input.date,
        memo: `Invoice ${invNumber}`,
        reference: invNumber,
        source: "invoice",
        sourceId: inv.id,
        lines,
      }, { _tx: tx });
      await this.audit("create", "invoice", inv.id, `Created invoice ${invNumber} (${formatMoney(total)})`);

      // ---- Inventory: relieve stock + post COGS ----
      // Sales of inventory items decrement quantity_on_hand and book their own
      // balanced entry (Dr COGS / Cr Inventory Asset) in THIS SAME transaction,
      // so a rolled-back invoice never leaves an orphaned COGS entry or stray
      // stock change. COGS is costed by the org's method: weighted AVERAGE, or
      // FIFO/LIFO by consuming cost layers (oldest/newest first).
      const costingMethod = await this.orgCostingMethod();
      // Working per-item layer arrays (loaded lazily, ordered per method). We
      // mutate them across lines via relieveLayers, then persist below.
      const layerCache = new Map<number, Array<{ id: number; qtyRemaining: number; costRemainingCents: number }>>();
      const loadLayers = async (itemId: number): Promise<Array<{ id: number; qtyRemaining: number; costRemainingCents: number }>> => {
        const existing = layerCache.get(itemId);
        if (existing) return existing;
        const rows = await tx.select().from(inventoryLayers)
          .where(and(eq(inventoryLayers.itemId, itemId), eq(inventoryLayers.orgId, currentOrgId()), gt(inventoryLayers.qtyRemaining, 0)))
          .orderBy(
            costingMethod === "lifo" ? desc(inventoryLayers.date) : inventoryLayers.date,
            costingMethod === "lifo" ? desc(inventoryLayers.id) : inventoryLayers.id,
          );
        const arr = rows.map((r: any) => ({ id: r.id, qtyRemaining: r.qtyRemaining, costRemainingCents: Number(r.costRemainingCents) }));
        layerCache.set(itemId, arr);
        return arr;
      };

      const cogsComponents: CogsComponent[] = [];
      const saleMovements: { itemId: number; qty: number; avgCostCents: number }[] = [];
      const workingQty = new Map<number, number>(); // item id -> running on-hand
      for (let idx = 0; idx < input.lines.length; idx++) {
        const l = input.lines[idx];
        if (l.itemId === undefined) continue;
        const item = invItemMap.get(l.itemId)!;
        if (item.type !== "inventory") continue;
        if (!Number.isInteger(l.quantity)) {
          throw new Error(`Inventory item "${item.sku}" must be sold in whole units (got ${l.quantity}).`);
        }
        const startQty = workingQty.get(item.id) ?? item.quantityOnHand;
        const newQty = startQty - l.quantity;
        if (newQty < 0 && !allowNegative) {
          throw new Error(
            `Selling ${l.quantity} of "${item.sku}" would drive stock to ${newQty} (on hand ${startQty}). ` +
            `Enable allow_negative_stock for this organization to permit overselling.`
          );
        }
        workingQty.set(item.id, newQty);
        // Cost the sale. FIFO/LIFO consume layers (fallback to avg cost for any
        // shortfall past the layers, i.e. oversold negative stock).
        let cogsCents: number;
        let movementUnitCost: number;
        if (costingMethod === "average") {
          cogsCents = l.quantity * item.avgCostCents;
          movementUnitCost = item.avgCostCents;
        } else {
          const layers = await loadLayers(item.id);
          cogsCents = relieveLayers(layers, l.quantity, item.avgCostCents);
          movementUnitCost = l.quantity > 0 ? Math.round(cogsCents / l.quantity) : 0;
        }
        // inventoryAssetAccountId is guaranteed non-null for type 'inventory' (schema refine + createItem).
        cogsComponents.push({ cogsAccountId: item.cogsAccountId, inventoryAssetAccountId: item.inventoryAssetAccountId!, cogsCents });
        saleMovements.push({ itemId: item.id, qty: l.quantity, avgCostCents: movementUnitCost });
      }
      const cogsLines = buildCogsJournalLines(cogsComponents, `COGS for ${invNumber}`);
      if (cogsLines.length > 0) {
        const cogsEntry = await this.postJournalEntry({
          date: input.date,
          memo: `COGS for invoice ${invNumber}`,
          reference: invNumber,
          source: "cogs",
          sourceId: inv.id,
          lines: cogsLines,
        }, { _tx: tx });
        for (const mv of saleMovements) {
          await tx.insert(inventoryMovements).values({
            orgId: currentOrgId(),
            itemId: mv.itemId,
            date: input.date,
            qtyDelta: -mv.qty,
            unitCostCents: mv.avgCostCents,
            source: "invoice",
            sourceId: inv.id,
            entryId: cogsEntry.entry.id,
          });
        }
        for (const [itemId, qtyOnHand] of workingQty) {
          await tx.update(items).set({ quantityOnHand: qtyOnHand, updatedAt: nowIso() })
            .where(and(eq(items.id, itemId), eq(items.orgId, currentOrgId())));
        }
        // FIFO/LIFO: persist the consumed cost layers.
        if (costingMethod !== "average") {
          for (const layers of layerCache.values()) {
            for (const layer of layers) {
              await tx.update(inventoryLayers)
                .set({ qtyRemaining: layer.qtyRemaining, costRemainingCents: layer.costRemainingCents })
                .where(and(eq(inventoryLayers.id, layer.id), eq(inventoryLayers.orgId, currentOrgId())));
            }
          }
        }
        const totalCogs = cogsComponents.reduce((s, c) => s + c.cogsCents, 0);
        await this.audit("post", "inventory_cogs", inv.id, `Relieved inventory for invoice ${invNumber} (COGS ${formatMoney(totalCogs)})`);
      }
      // Non-blocking future-dated warning for the client (soft mode).
      if (futureWarning) (inv as any).warnings = [futureWarning];
      return inv;
    };

    try {
      if (opts._tx) {
        // Caller owns the transaction + commit; it emits invoice.created afterwards.
        return await doCreate(opts._tx);
      }
      const inv = await db.transaction(doCreate);
      // Webhooks fire AFTER commit — a rolled-back invoice must never notify.
      await emitWebhookEvent("invoice.created", { id: inv.id, number: inv.number, total: inv.total, currency: inv.currency || null });
      return inv;
    } catch (err: any) {
      // Postgres unique-violation on UNIQUE(org_id, number) → clean business
      // error instead of a raw 500. Drizzle may wrap the pg error, so check
      // both err.code and err.cause.code. "already" maps to HTTP 400 via
      // routes.ts USER_ERROR_PATTERNS.
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        throw new Error(`Invoice number "${invNumber}" already exists in this organization.`);
      }
      throw err;
    }
  }

  async listInvoices(limit = 50, offset = 0): Promise<Paginated<Invoice & { customerName?: string }>> {
    const where = eq(invoices.orgId, currentOrgId());
    // total from the SAME WHERE. The join is an INNER JOIN on customer_id — count
    // through the same join so total always equals the number of listable rows.
    const [{ total }] = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(where);
    const rows = await db
      .select({ inv: invoices, customer: customers })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(where)
      .orderBy(desc(invoices.date), desc(invoices.id))
      .limit(limit)
      .offset(offset)
      ;
    return { rows: rows.map((r) => ({ ...r.inv, customerName: r.customer.name })), total, limit, offset };
  }

  async getInvoice(id: number): Promise<(Invoice & { lines: InvoiceLine[]; customer?: Customer }) | undefined> {
    const inv = await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!inv) return undefined;
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    const customer = await db.select().from(customers).where(and(eq(customers.id, inv.customerId), eq(customers.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    return { ...inv, lines, customer };
  }

  async payInvoice(input: PayInvoiceInput): Promise<Invoice> {
    const ar = await db.select().from(accounts).where(and(eq(accounts.code, "1100"), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!ar) throw new Error("A/R account missing");
    const inv = await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "void") throw new Error(`Invoice ${inv.number} is voided.`);
    if (await this.isDateLocked(input.date)) {
      throw new Error(`Cannot record payment on ${input.date}: that period is closed.`);
    }
    // Validate the receiving account is a bank-type asset
    const bankAcct = await db.select().from(accounts).where(and(eq(accounts.id, input.bankAccountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!bankAcct) throw new Error("Bank account not found");
    if (bankAcct.type !== "asset" || bankAcct.subtype !== "bank") {
      throw new Error(`Receiving account "${bankAcct.name}" must be a bank-subtype asset (got ${bankAcct.type}/${bankAcct.subtype || "no subtype"}).`);
    }
    // ------------------------------------------------------------------------
    // FX vs base payment paths.
    //
    // BASE documents (inv.currency === ""): unchanged — Dr Bank / Cr A/R for
    // the tendered base cents.
    //
    // FX documents: caller supplies foreignAmount (document currency) + the
    // PAYMENT-date fxRate. Realized gain/loss = difference between what A/R
    // carries the money at (DOCUMENT rate) and what the bank actually got
    // (PAYMENT rate). WORKED EXAMPLE — €100 invoice booked @ 1.10:
    //     A/R carries ................. $110.00  (foreignTotal 10000¢ × 1.10)
    //   Customer pays €100 when the rate is 1.08:
    //     Bank receives ............... $108.00  (10000¢ × 1.08)
    //     A/R must be relieved IN FULL   $110.00  (the receivable is gone)
    //     JE:  DR Bank 10800
    //          DR FX Loss (6950) 200      ← plugs the difference
    //              CR A/R 11000
    //   If instead the rate had risen to 1.12:
    //     JE:  DR Bank 11200
    //              CR A/R 11000
    //              CR FX Gain (4950) 200
    // Partial payments relieve A/R proportionally at the DOCUMENT rate:
    // relieved = round(foreignApplied × inv.fxRate).
    // ------------------------------------------------------------------------
    const isFxDoc = !!inv.currency;
    let amountCents: number;          // base cents hitting the bank
    let arRelievedCents: number;      // base cents credited to A/R
    let foreignCents = 0;             // foreign cents applied to the document
    let fxDiff = 0;                   // arRelieved - received; >0 = loss, <0 = gain

    if (isFxDoc) {
      if (!input.foreignAmount || !(input.foreignAmount > 0) || !input.fxRate || !(input.fxRate > 0)) {
        throw new Error(`Invoice ${inv.number} is in ${inv.currency}: provide foreignAmount and the payment-date fxRate (both > 0).`);
      }
      foreignCents = toCents(input.foreignAmount);
      const foreignRemaining = inv.foreignTotal - inv.foreignAmountPaid;
      if (foreignCents > foreignRemaining) {
        throw new Error(`Payment of ${formatMoney(foreignCents, inv.currency)} exceeds invoice balance of ${formatMoney(foreignRemaining, inv.currency)}.`);
      }
      amountCents = Math.round(foreignCents * input.fxRate);      // PAYMENT rate → bank
      arRelievedCents = Math.round(foreignCents * inv.fxRate);    // DOCUMENT rate → A/R relief
      fxDiff = arRelievedCents - amountCents;
    } else {
      // API input is user dollars — convert ONCE at the boundary; all math below
      // is exact integer cents.
      amountCents = toCents(input.amount);
      // Prevent overpayment (exact integer comparison — no epsilon needed)
      const remaining = inv.total - inv.amountPaid;
      if (amountCents > remaining) {
        throw new Error(`Payment of ${formatMoney(amountCents)} exceeds invoice balance of ${formatMoney(remaining)}.`);
      }
      arRelievedCents = amountCents;
    }
    const fxAccts = isFxDoc && fxDiff !== 0 ? await this.ensureFxAccounts() : null;

    return await db.transaction(async (tx) => {
      const newPaid = inv.amountPaid + arRelievedCents;           // base carrying amount relieved
      const newForeignPaid = inv.foreignAmountPaid + foreignCents;
      const newStatus = isFxDoc
        ? (newForeignPaid >= inv.foreignTotal ? "paid" : "open")  // FX docs settle in the document currency
        : (newPaid >= inv.total ? "paid" : "open");
      const updated = await tx
        .update(invoices)
        .set({ amountPaid: newPaid, status: newStatus, foreignAmountPaid: newForeignPaid })
        .where(eq(invoices.id, inv.id))
        .returning().then((r) => r[0]);
      // DR Bank (payment rate), DR FX Loss / CR FX Gain (plug), CR A/R (document rate)
      const jeLines: Array<{ accountId: number; debit: number; credit: number; description?: string }> = [
        { accountId: input.bankAccountId, debit: amountCents, credit: 0 },
      ];
      if (fxAccts && fxDiff > 0) jeLines.push({ accountId: fxAccts.loss.id, debit: fxDiff, credit: 0, description: `Realized FX loss on ${inv.number}` });
      if (fxAccts && fxDiff < 0) jeLines.push({ accountId: fxAccts.gain.id, debit: 0, credit: -fxDiff, description: `Realized FX gain on ${inv.number}` });
      jeLines.push({ accountId: ar.id, debit: 0, credit: arRelievedCents });
      await this.postJournalEntry({
        date: input.date,
        memo: input.memo || `Payment for ${inv.number}`,
        reference: inv.number,
        source: "payment",
        sourceId: inv.id,
        lines: jeLines,
      }, { _tx: tx });
      await this.audit("pay", "invoice", inv.id,
        isFxDoc
          ? `Payment ${formatMoney(foreignCents, inv.currency)} @ ${input.fxRate} (${formatMoney(amountCents)}) on invoice ${inv.number}${fxDiff !== 0 ? `; FX ${fxDiff > 0 ? "loss" : "gain"} ${formatMoney(Math.abs(fxDiff))}` : ""}`
          : `Payment ${formatMoney(amountCents)} on invoice ${inv.number}`);
      return updated;
    }).then(async (updated) => {
      await emitWebhookEvent("invoice.paid", { id: updated.id, number: updated.number, amountPaid: updated.amountPaid, status: updated.status });
      return updated;
    });
  }

  async voidInvoice(id: number, voidDate?: string): Promise<Invoice | undefined> {
    // Bug-fix (Bug #7 — Voiding/Reversal): a void must POST A BALANCED REVERSAL
    // journal entry, not just flip a status flag. The original entry is
    // preserved (immutable audit trail) and an offsetting entry brings A/R,
    // revenue, and any tax-payable balance back to zero.
    const inv = await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!inv) return undefined;
    if (inv.status === "void") return inv; // idempotent
    if ((inv.amountPaid || 0) > 0) {
      throw new Error(
        `Cannot void ${inv.number}: ${formatMoney(inv.amountPaid)} has been paid. Refund/unapply payments first.`
      );
    }

    const today = voidDate || new Date().toISOString().slice(0, 10);
    if (await this.isDateLocked(today)) {
      throw new Error(`Cannot void on ${today}: that period is closed.`);
    }

    return await db.transaction(async (tx) => {
      // Find the original "invoice" journal entry for this invoice
      const original = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.source, "invoice"),
            eq(journalEntries.sourceId, inv.id),
            // Defense-in-depth: inv is already org-scoped; the explicit filter
            // guarantees source+sourceId can never resolve across tenants.
            eq(journalEntries.orgId, currentOrgId())
          )
        )
        .then((r: any[]) => r[0]);

      if (original) {
        const origLines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, original.id))
          ;

        // Flip DR↔CR on every line to produce a balanced reversal
        const reversalLines = origLines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit || 0,
          credit: l.debit || 0,
          description: `Reversal of ${inv.number}`,
        }));

        if (reversalLines.length >= 2) {
          await this.postJournalEntry({
            date: today,
            memo: `Void invoice ${inv.number}`,
            reference: `VOID-${inv.number}`,
            source: "invoice_void",
            sourceId: inv.id,
            lines: reversalLines,
          }, { _tx: tx });
        }
      }

      const row = await tx
        .update(invoices)
        .set({ status: "void" })
        .where(eq(invoices.id, id))
        .returning().then((r) => r[0]);
      await this.audit("void", "invoice", id, `Voided invoice ${row.number} (reversal posted)`);
      return row;
    }).then(async (row) => {
      await emitWebhookEvent("invoice.voided", { id: row.id, number: row.number });
      return row;
    });
  }

  // ---------- Bills ----------
  // opts._tx: optional external drizzle transaction. When supplied (e.g. by
  // receivePurchaseOrder) all of this bill's writes — the bill, its lines, the
  // journal entry, and any inventory movements — join the caller's transaction
  // so the whole receipt commits or rolls back atomically. In that mode the
  // bill.created webhook is NOT emitted here; the caller fires it after the
  // outer commit (a rolled-back bill must never notify).
  async createBill(input: CreateBillInput, opts: { _tx?: any } = {}): Promise<Bill> {
    // Future-dated guard (BUG-005): throws in strict mode BEFORE any write;
    // otherwise yields a warning attached to the returned bill below.
    const futureWarning = await this.checkFutureDate(input.date, "bill");
    // Auto-numbering: same contract as createInvoice (see comment there).
    const billNumber: string = input.number ?? await this.nextNumber("bill");
    const ap = await db.select().from(accounts).where(and(eq(accounts.code, "2000"), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!ap) throw new Error("Accounts Payable account (2000) missing");

    // Resolve catalog items referenced by lines. The GL debit account is DERIVED
    // from the item (never taken from the request): an inventory item capitalizes
    // its purchase to the Inventory Asset account and raises stock; a
    // service/non-inventory item debits its expense account.
    const billItemMap = await this.loadItemsForLines(
      input.lines.filter((l) => l.itemId !== undefined).map((l) => l.itemId as number)
    );
    const resolvedDebitAccountIds: number[] = input.lines.map((l) => {
      if (l.itemId !== undefined) {
        const item = billItemMap.get(l.itemId)!;
        return item.type === "inventory" ? item.inventoryAssetAccountId! : item.expenseAccountId;
      }
      if (l.expenseAccountId !== undefined) return l.expenseAccountId;
      throw new Error("Bill line requires itemId or expenseAccountId");
    });

    // Resolve tax rate and a dedicated tax account.
    // For purchases we use Sales Tax Receivable (asset, code 1150) when available
    // — this represents recoverable VAT/GST. If 1150 is missing (older datasets),
    // we fall back to expensing the tax to the first expense account on the bill.
    let effectiveRate = input.taxRate;
    if (input.taxCodeId) {
      const code = await this.getTaxCode(input.taxCodeId);
      if (!code) throw new Error("Tax code not found");
      effectiveRate = code.rate;
    }
    const taxAsset = await db.select().from(accounts).where(and(eq(accounts.code, "1150"), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);

    // Per-line rounding then sum (same fix as createInvoice — guarantees JE balances).
    // Integer cents per line: rate is a dollar unit-price input; Math.round
    // converts to exact cents once, here, and never again downstream.
    // FX: same per-line rounding discipline as createInvoice — see the worked
    // comment there. Foreign cents from line math; base = round(line * rate).
    const fx = await this.resolveDocumentFx(input.currency, input.fxRate);
    const lineAmountsRaw: number[] = input.lines.map((l) => Math.round(l.quantity * l.rate * 100));
    let lineAmounts: number[];
    let foreignSubtotal = 0, foreignTax = 0, foreignTotal = 0;
    let subtotal: number, tax: number, total: number;
    if (fx) {
      foreignSubtotal = lineAmountsRaw.reduce((s, a) => s + a, 0);
      foreignTax = Math.round((foreignSubtotal * effectiveRate) / 100);
      foreignTotal = foreignSubtotal + foreignTax;
      lineAmounts = lineAmountsRaw.map((a) => Math.round(a * fx.fxRate));
      subtotal = lineAmounts.reduce((s, a) => s + a, 0);
      tax = Math.round(foreignTax * fx.fxRate);
      total = subtotal + tax;
    } else {
      lineAmounts = lineAmountsRaw;
      subtotal = lineAmounts.reduce((s, a) => s + a, 0); // exact integer sum
      tax = Math.round((subtotal * effectiveRate) / 100); // integer cents
      total = subtotal + tax; // exact integer cents
    }

    const doCreate = async (tx: any): Promise<Bill> => {
      const b = await tx
        .insert(bills)
        .values({
          orgId: currentOrgId(),
          number: billNumber,
          currency: fx?.currency ?? "",
          fxRate: fx?.fxRate ?? 1,
          foreignSubtotal,
          foreignTax,
          foreignTotal,
          foreignAmountPaid: 0,
          vendorId: input.vendorId,
          date: input.date,
          dueDate: input.dueDate,
          status: "open",
          subtotal,
          tax,
          total,
          amountPaid: 0,
          notes: input.notes,
        })
        .returning().then((r: any[]) => r[0]);
      for (let idx = 0; idx < input.lines.length; idx++) {
        const l = input.lines[idx];
        await tx.insert(billLines)
          .values({
            orgId: currentOrgId(),
            billId: b.id,
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            amount: fx ? lineAmountsRaw[idx] : lineAmounts[idx], // document-currency detail for FX
            expenseAccountId: resolvedDebitAccountIds[idx],
            itemId: l.itemId ?? null,
            classId: (l as any).classId ?? null,
            locationId: (l as any).locationId ?? null,
            projectId: (l as any).projectId ?? null,
          });
      }
      // Dr each Expense/Inventory account (rounded line amounts), Dr Sales Tax
      // Receivable (or first debit acct as fallback), Cr A/P. Group the debits by
      // (account, class, location, project) so dimensions land on the GL.
      const lines: any[] = [];
      const expMap = new Map<string, { accountId: number; classId: number | null; locationId: number | null; projectId: number | null; amt: number }>();
      input.lines.forEach((l, idx) => {
        const acctId = resolvedDebitAccountIds[idx];
        const classId = (l as any).classId ?? null;
        const locationId = (l as any).locationId ?? null;
        const projectId = (l as any).projectId ?? null;
        const key = `${acctId}|${classId}|${locationId}|${projectId}`;
        const cur = expMap.get(key);
        if (cur) cur.amt += lineAmounts[idx];
        else expMap.set(key, { accountId: acctId, classId, locationId, projectId, amt: lineAmounts[idx] });
      });
      for (const g of expMap.values()) {
        lines.push({ accountId: g.accountId, debit: g.amt, credit: 0, description: `Bill ${billNumber}`, classId: g.classId, locationId: g.locationId, projectId: g.projectId });
      }
      if (tax > 0) {
        const taxAcctId = taxAsset?.id ?? [...expMap.keys()][0];
        const taxLabel = taxAsset ? "Sales tax receivable" : "Sales tax (expensed — no 1150 account)";
        lines.push({ accountId: taxAcctId, debit: tax, credit: 0, description: `${taxLabel} on ${billNumber}` });
      }
      lines.push({ accountId: ap.id, debit: 0, credit: total, description: `Bill ${billNumber}` });
      const billEntry = await this.postJournalEntry({
        date: input.date,
        memo: `Bill ${billNumber}`,
        reference: billNumber,
        source: "bill",
        sourceId: b.id,
        lines,
      }, { _tx: tx });
      await this.audit("create", "bill", b.id, `Created bill ${billNumber} (${formatMoney(total)})`);

      // ---- Inventory: raise stock for item lines ----
      // The purchase was already capitalized to the Inventory Asset account by
      // the bill entry above (its debit is `lineAmounts[idx]` base cents). Here
      // we mirror that into quantity_on_hand and recompute the running average
      // (always, so it's available for the average method), AND — under FIFO/LIFO
      // — record a cost LAYER for this lot. Same-item lines fold sequentially.
      const costingMethod = await this.orgCostingMethod();
      const working = new Map<number, { qtyOnHand: number; avgCostCents: number }>();
      let touchedInventory = false;
      for (let idx = 0; idx < input.lines.length; idx++) {
        const l = input.lines[idx];
        if (l.itemId === undefined) continue;
        const item = billItemMap.get(l.itemId)!;
        if (item.type !== "inventory") continue;
        if (!Number.isInteger(l.quantity)) {
          throw new Error(`Inventory item "${item.sku}" must be purchased in whole units (got ${l.quantity}).`);
        }
        touchedInventory = true;
        const state = working.get(item.id) ?? { qtyOnHand: item.quantityOnHand, avgCostCents: item.avgCostCents };
        const valueCents = lineAmounts[idx]; // base-currency cents debited to inventory
        const res = applyPurchase(state, l.quantity, valueCents);
        working.set(item.id, { qtyOnHand: res.qtyOnHand, avgCostCents: res.avgCostCents });
        await tx.insert(inventoryMovements).values({
          orgId: currentOrgId(),
          itemId: item.id,
          date: input.date,
          qtyDelta: l.quantity,
          unitCostCents: res.unitCostCents,
          source: "bill",
          sourceId: b.id,
          entryId: billEntry.entry.id,
        });
        // FIFO/LIFO: record the purchase lot as a cost layer (remaining qty +
        // remaining cost = the exact base cents capitalized for this line).
        if (costingMethod !== "average") {
          await tx.insert(inventoryLayers).values({
            orgId: currentOrgId(),
            itemId: item.id,
            date: input.date,
            qtyRemaining: l.quantity,
            costRemainingCents: valueCents,
            unitCostCents: res.unitCostCents,
            source: "bill",
            sourceId: b.id,
          });
        }
      }
      if (touchedInventory) {
        for (const [itemId, st] of working) {
          await tx.update(items).set({ quantityOnHand: st.qtyOnHand, avgCostCents: st.avgCostCents, updatedAt: nowIso() })
            .where(and(eq(items.id, itemId), eq(items.orgId, currentOrgId())));
        }
        await this.audit("post", "inventory_receipt", b.id, `Received inventory on bill ${billNumber}`);
      }
      // Non-blocking future-dated warning for the client (soft mode).
      if (futureWarning) (b as any).warnings = [futureWarning];
      return b;
    };

    try {
      if (opts._tx) {
        // Caller owns the transaction + commit; it emits bill.created afterwards.
        return await doCreate(opts._tx);
      }
      const b = await db.transaction(doCreate);
      await emitWebhookEvent("bill.created", { id: b.id, number: b.number, total: b.total, currency: b.currency || null });
      return b;
    } catch (err: any) {
      // Postgres unique-violation on UNIQUE(org_id, number) → clean business
      // error instead of a raw 500 (drizzle may wrap the pg error).
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        throw new Error(`Bill number "${billNumber}" already exists in this organization.`);
      }
      throw err;
    }
  }

  async listBills(limit = 50, offset = 0): Promise<Paginated<Bill & { vendorName?: string }>> {
    const where = eq(bills.orgId, currentOrgId());
    const [{ total }] = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(bills)
      .innerJoin(vendors, eq(bills.vendorId, vendors.id))
      .where(where);
    const rows = await db
      .select({ bill: bills, vendor: vendors })
      .from(bills)
      .innerJoin(vendors, eq(bills.vendorId, vendors.id))
      .where(where)
      .orderBy(desc(bills.date), desc(bills.id))
      .limit(limit)
      .offset(offset)
      ;
    return { rows: rows.map((r) => ({ ...r.bill, vendorName: r.vendor.name })), total, limit, offset };
  }

  async getBill(id: number): Promise<(Bill & { lines: BillLine[]; vendor?: Vendor }) | undefined> {
    const b = await db.select().from(bills).where(and(eq(bills.id, id), eq(bills.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!b) return undefined;
    const lines = await db.select().from(billLines).where(eq(billLines.billId, id));
    const vendor = await db.select().from(vendors).where(and(eq(vendors.id, b.vendorId), eq(vendors.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    return { ...b, lines, vendor };
  }

  async payBill(input: PayBillInput): Promise<Bill> {
    const ap = await db.select().from(accounts).where(and(eq(accounts.code, "2000"), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!ap) throw new Error("A/P account missing");
    const bill = await db.select().from(bills).where(and(eq(bills.id, input.billId), eq(bills.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!bill) throw new Error("Bill not found");
    if (bill.status === "void") throw new Error(`Bill ${bill.number} is voided.`);
    if (await this.isDateLocked(input.date)) {
      throw new Error(`Cannot record payment on ${input.date}: that period is closed.`);
    }
    // Validate paying account is a bank- or credit-card-subtype asset/liability
    const payAcct = await db.select().from(accounts).where(and(eq(accounts.id, input.bankAccountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!payAcct) throw new Error("Paying account not found");
    const isBank = payAcct.type === "asset" && payAcct.subtype === "bank";
    const isCard = payAcct.type === "liability" && payAcct.subtype === "credit_card";
    if (!isBank && !isCard) {
      throw new Error(`Paying account "${payAcct.name}" must be a bank-subtype asset or credit-card liability.`);
    }
    // ------------------------------------------------------------------------
    // FX vs base payment — MIRROR of payInvoice, signs flipped for payables.
    // WORKED EXAMPLE — €100 bill booked @ 1.10 → A/P carries $110.00.
    //   We pay €100 when the rate is 1.08 → bank pays out only $108.00:
    //     JE:  DR A/P 11000                (liability relieved at DOCUMENT rate)
    //              CR Bank 10800           (cash out at PAYMENT rate)
    //              CR FX Gain (4950) 200   (we settled a $110 debt with $108)
    //   Rate 1.12 instead → bank pays $112.00:
    //     JE:  DR A/P 11000
    //          DR FX Loss (6950) 200
    //              CR Bank 11200
    // ------------------------------------------------------------------------
    const isFxDoc = !!bill.currency;
    let amountCents: number;       // base cents leaving the bank
    let apRelievedCents: number;   // base cents debited to A/P
    let foreignCents = 0;
    let fxDiff = 0;                // apRelieved - paid; >0 = gain, <0 = loss (payable side)

    if (isFxDoc) {
      if (!input.foreignAmount || !(input.foreignAmount > 0) || !input.fxRate || !(input.fxRate > 0)) {
        throw new Error(`Bill ${bill.number} is in ${bill.currency}: provide foreignAmount and the payment-date fxRate (both > 0).`);
      }
      foreignCents = toCents(input.foreignAmount);
      const foreignRemaining = bill.foreignTotal - bill.foreignAmountPaid;
      if (foreignCents > foreignRemaining) {
        throw new Error(`Payment of ${formatMoney(foreignCents, bill.currency)} exceeds bill balance of ${formatMoney(foreignRemaining, bill.currency)}.`);
      }
      amountCents = Math.round(foreignCents * input.fxRate);
      apRelievedCents = Math.round(foreignCents * bill.fxRate);
      fxDiff = apRelievedCents - amountCents;
    } else {
      // API input is user dollars — convert ONCE at the boundary.
      amountCents = toCents(input.amount);
      const remaining = bill.total - bill.amountPaid;
      if (amountCents > remaining) {
        throw new Error(`Payment of ${formatMoney(amountCents)} exceeds bill balance of ${formatMoney(remaining)}.`);
      }
      apRelievedCents = amountCents;
    }
    const fxAccts = isFxDoc && fxDiff !== 0 ? await this.ensureFxAccounts() : null;

    return await db.transaction(async (tx) => {
      const newPaid = bill.amountPaid + apRelievedCents;
      const newForeignPaid = bill.foreignAmountPaid + foreignCents;
      const newStatus = isFxDoc
        ? (newForeignPaid >= bill.foreignTotal ? "paid" : "open")
        : (newPaid >= bill.total ? "paid" : "open");
      const updated = await tx
        .update(bills)
        .set({ amountPaid: newPaid, status: newStatus, foreignAmountPaid: newForeignPaid })
        .where(eq(bills.id, bill.id))
        .returning().then((r) => r[0]);
      // DR A/P (document rate), CR Bank (payment rate), plug to FX Gain/Loss.
      // (Cr Bank also covers credit-card liability — credit still increases it.)
      const jeLines: Array<{ accountId: number; debit: number; credit: number; description?: string }> = [
        { accountId: ap.id, debit: apRelievedCents, credit: 0 },
      ];
      if (fxAccts && fxDiff < 0) jeLines.push({ accountId: fxAccts.loss.id, debit: -fxDiff, credit: 0, description: `Realized FX loss on ${bill.number}` });
      jeLines.push({ accountId: input.bankAccountId, debit: 0, credit: amountCents });
      if (fxAccts && fxDiff > 0) jeLines.push({ accountId: fxAccts.gain.id, debit: 0, credit: fxDiff, description: `Realized FX gain on ${bill.number}` });
      await this.postJournalEntry({
        date: input.date,
        memo: input.memo || `Payment for ${bill.number}`,
        reference: bill.number,
        source: "payment",
        sourceId: bill.id,
        lines: jeLines,
      }, { _tx: tx });
      await this.audit("pay", "bill", bill.id,
        isFxDoc
          ? `Payment ${formatMoney(foreignCents, bill.currency)} @ ${input.fxRate} (${formatMoney(amountCents)}) on bill ${bill.number}${fxDiff !== 0 ? `; FX ${fxDiff > 0 ? "gain" : "loss"} ${formatMoney(Math.abs(fxDiff))}` : ""}`
          : `Payment ${formatMoney(amountCents)} on bill ${bill.number}`);
      return updated;
    }).then(async (updated) => {
      await emitWebhookEvent("bill.paid", { id: updated.id, number: updated.number, amountPaid: updated.amountPaid, status: updated.status });
      return updated;
    });
  }

  async voidBill(id: number, voidDate?: string): Promise<Bill | undefined> {
    // Mirror of voidInvoice: post a balanced reversal JE and flag the bill void.
    // Original JE is preserved for audit trail.
    const bill = await db.select().from(bills).where(and(eq(bills.id, id), eq(bills.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!bill) return undefined;
    if (bill.status === "void") return bill; // idempotent
    if ((bill.amountPaid || 0) > 0) {
      throw new Error(
        `Cannot void ${bill.number}: ${formatMoney(bill.amountPaid)} has been paid. Reverse the payment first.`
      );
    }

    const today = voidDate || new Date().toISOString().slice(0, 10);
    if (await this.isDateLocked(today)) {
      throw new Error(`Cannot void on ${today}: that period is closed.`);
    }

    return await db.transaction(async (tx) => {
      const original = await tx
        .select()
        .from(journalEntries)
        // orgId is defense-in-depth: bill is already org-scoped (see voidInvoice).
        .where(and(eq(journalEntries.source, "bill"), eq(journalEntries.sourceId, bill.id), eq(journalEntries.orgId, currentOrgId())))
        .then((r: any[]) => r[0]);

      if (original) {
        const origLines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, original.id))
          ;

        const reversalLines = origLines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit || 0,
          credit: l.debit || 0,
          description: `Reversal of ${bill.number}`,
        }));

        if (reversalLines.length >= 2) {
          await this.postJournalEntry({
            date: today,
            memo: `Void bill ${bill.number}`,
            reference: `VOID-${bill.number}`,
            source: "bill_void",
            sourceId: bill.id,
            lines: reversalLines,
          }, { _tx: tx });
        }
      }

      const row = await tx
        .update(bills)
        .set({ status: "void" })
        .where(eq(bills.id, id))
        .returning().then((r) => r[0]);
      await this.audit("void", "bill", id, `Voided bill ${row.number} (reversal posted)`);
      return row;
    });
  }

  // ---------- Bank Transactions ----------
  async listBankTransactions(
    bankAccountId?: number,
    status?: string,
    limit = 50,
    offset = 0
  ): Promise<Paginated<BankTransaction>> {
    // Filters moved from post-load JS into the SQL WHERE clause (Task 1) —
    // previously every row for the org was loaded and filtered in memory.
    const conditions: any[] = [eq(bankTransactions.orgId, currentOrgId())];
    if (bankAccountId !== undefined) conditions.push(eq(bankTransactions.bankAccountId, bankAccountId));
    if (status) conditions.push(eq(bankTransactions.status, status));
    const where = and(...conditions);
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(bankTransactions).where(where);
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(where)
      .orderBy(desc(bankTransactions.date), desc(bankTransactions.id))
      .limit(limit)
      .offset(offset)
      ;
    return { rows, total, limit, offset };
  }

  async getBankTransaction(id: number): Promise<BankTransaction | undefined> {
    return await db.select().from(bankTransactions).where(and(eq(bankTransactions.id, id), eq(bankTransactions.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }

  // Manual posting: create both the bank_transactions row AND a journal entry in one shot.
  // - deposit:    Dr bank, Cr categoryAccount (typically income, or owner's equity for capital)
  // - withdrawal: Dr categoryAccount (expense), Cr bank
  // - transfer:   Dr destinationBank, Cr sourceBank (use transferAccountId as the OTHER side)
  async postManualBankTransaction(input: PostBankTransactionInput): Promise<BankTransaction> {
    const bank = await db.select().from(accounts).where(and(eq(accounts.id, input.bankAccountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!bank) throw new Error("Bank account not found");
    if (bank.subtype !== "bank" && bank.subtype !== "credit_card") {
      throw new Error("Selected account is not a bank or credit card account");
    }

    // User input is signed dollars — convert ONCE to integer cents.
    const amountCents = toCents(input.amount);
    const absAmount = Math.abs(amountCents);
    if (absAmount === 0) throw new Error("Amount must be non-zero");

    return await db.transaction(async (tx) => {
      let lines: any[] = [];
      let memo = input.description;

      if (input.kind === "deposit") {
        if (!input.categoryAccountId) throw new Error("categoryAccountId required for deposit");
        if (input.amount <= 0) throw new Error("Deposit amount must be positive");
        lines = [
          { accountId: input.bankAccountId, debit: absAmount, credit: 0, description: input.description },
          { accountId: input.categoryAccountId, debit: 0, credit: absAmount, description: input.description },
        ];
      } else if (input.kind === "withdrawal") {
        if (!input.categoryAccountId) throw new Error("categoryAccountId required for withdrawal");
        if (input.amount >= 0) throw new Error("Withdrawal amount must be negative");
        lines = [
          { accountId: input.categoryAccountId, debit: absAmount, credit: 0, description: input.description },
          { accountId: input.bankAccountId, debit: 0, credit: absAmount, description: input.description },
        ];
      } else if (input.kind === "transfer") {
        if (!input.transferAccountId) throw new Error("transferAccountId required for transfer");
        if (input.transferAccountId === input.bankAccountId) {
          throw new Error("Cannot transfer to the same account");
        }
        // If amount is positive, money INTO bankAccountId from transferAccountId (i.e. bankAccountId is destination)
        // If amount is negative, money OUT of bankAccountId to transferAccountId
        if (input.amount > 0) {
          lines = [
            { accountId: input.bankAccountId, debit: absAmount, credit: 0, description: input.description },
            { accountId: input.transferAccountId, debit: 0, credit: absAmount, description: input.description },
          ];
        } else {
          lines = [
            { accountId: input.transferAccountId, debit: absAmount, credit: 0, description: input.description },
            { accountId: input.bankAccountId, debit: 0, credit: absAmount, description: input.description },
          ];
        }
        memo = `Transfer: ${input.description}`;
      }

      const { entry } = await this.postJournalEntry({
        date: input.date,
        memo,
        source: "deposit",
        lines,
      }, { _tx: tx });

      const bt = await tx
        .insert(bankTransactions)
        .values({
          orgId: currentOrgId(),
          bankAccountId: input.bankAccountId,
          date: input.date,
          description: input.description,
          amount: amountCents, // signed integer cents
          status: "matched",
          entryId: entry.id,
          source: "manual",
        })
        .returning().then((r) => r[0]);
      return bt;
    });
  }

  // Bulk import: insert all rows as 'unmatched'. Skips duplicates by (bankAccountId, externalId).
  // For rows without externalId (typical CSV imports), falls back to a soft dedup match on
  // (bankAccountId, date, amount, description) — not 100% accurate but prevents the most
  // common case of re-importing the same CSV creating duplicate transactions.
  // After import, auto-applies any matching active bank rules with autoPost=true.
  async importBankTransactions(input: ImportBankTransactionsInput): Promise<{ inserted: number; skipped: number; autoMatched: number; ruleFailures: number; ruleErrors: string[] }> {
    let inserted = 0;
    let skipped = 0;
    await db.transaction(async (tx) => {
      for (const raw of input.transactions) {
        // Imported amounts are signed dollars (CSV/Plaid) — convert once.
        const t = { ...raw, amount: toCents(raw.amount) };
        if (t.externalId) {
          const existing = (await pool.query(`SELECT id FROM bank_transactions WHERE bank_account_id = $1 AND external_id = $2`, [input.bankAccountId, t.externalId])).rows[0];
          if (existing) {
            skipped++;
            continue;
          }
        } else {
          // Soft dedup for CSV-style imports without a stable ID
          const existing = (await pool.query(`SELECT id FROM bank_transactions
               WHERE bank_account_id = $1 AND date = $2 AND amount = $3 AND description = $4
               LIMIT 1`, [input.bankAccountId, t.date, t.amount, t.description])).rows[0];
          if (existing) {
            skipped++;
            continue;
          }
        }
        await tx.insert(bankTransactions)
          .values({
          orgId: currentOrgId(),
            bankAccountId: input.bankAccountId,
            date: t.date,
            description: t.description,
            amount: t.amount,
            status: "unmatched",
            externalId: t.externalId,
            source: input.source,
          })
          ;
        inserted++;
      }
    });
    // Run rules outside the import tx (matchBankTransaction has its own tx)
    const ruleResult = inserted > 0
      ? await this.applyRulesToUnmatched(input.bankAccountId)
      : { matched: 0, failed: 0, errors: [] };
    return {
      inserted,
      skipped,
      autoMatched: ruleResult.matched,
      ruleFailures: ruleResult.failed,
      ruleErrors: ruleResult.errors,
    };
  }

  // Suggest matches: open invoices/bills within ±$0.01 amount, ±5 days date
  async suggestMatches(bankTransactionId: number) {
    const bt = await this.getBankTransaction(bankTransactionId);
    if (!bt) throw new Error("Bank transaction not found");

    const absAmt = Math.abs(bt.amount);
    const btDate = new Date(bt.date);
    const minDate = new Date(btDate.getTime() - 5 * 86400000).toISOString().slice(0, 10);
    const maxDate = new Date(btDate.getTime() + 5 * 86400000).toISOString().slice(0, 10);

    type Suggestion = {
      kind: "invoice" | "bill";
      id: number;
      number: string;
      date: string;
      partyName: string;
      total: number;
      balance: number;
      score: number;
    };
    const suggestions: Suggestion[] = [];

    if (bt.amount > 0) {
      // Money in -> match to open invoices.
      // Task 8b: targeted SQL — candidates only where the outstanding balance
      // equals the tx amount OR the date is within the ±5-day window, capped at
      // 200 rows. Scoring below is unchanged.
      const candidates = (await pool.query(
        `SELECT i.id, i.number, i.date, i.total, i.amount_paid AS "amountPaid", c.name AS "customerName"
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.org_id = $1
            AND i.status = 'open'
            AND (i.total - i.amount_paid) > 0
            AND ((i.total - i.amount_paid) = $2 OR (i.date >= $3 AND i.date <= $4))
          ORDER BY ((i.total - i.amount_paid) = $2) DESC, i.date DESC, i.id DESC
          LIMIT 200`,
        [currentOrgId(), absAmt, minDate, maxDate]
      )).rows as Array<{ id: number; number: string; date: string; total: number; amountPaid: number; customerName: string }>;
      for (const inv of candidates) {
        const balance = inv.total - inv.amountPaid; // exact integer cents
        if (balance <= 0) continue;
        const amountClose = balance === absAmt; // exact — integers never drift
        const dateClose = inv.date >= minDate && inv.date <= maxDate;
        if (amountClose || dateClose) {
          let score = 0;
          if (amountClose) score += 50;
          if (dateClose) score += 20;
          // Soft text match (customer name appears in description)
          if (inv.customerName && bt.description.toLowerCase().includes(inv.customerName.toLowerCase())) {
            score += 30;
          }
          if (score > 0) {
            suggestions.push({
              kind: "invoice",
              id: inv.id,
              number: inv.number,
              date: inv.date,
              partyName: inv.customerName || "",
              total: inv.total,
              balance,
              score,
            });
          }
        }
      }
    } else {
      // Money out -> match to open bills (same targeted-SQL pattern).
      const candidates = (await pool.query(
        `SELECT b.id, b.number, b.date, b.total, b.amount_paid AS "amountPaid", v.name AS "vendorName"
           FROM bills b
           JOIN vendors v ON v.id = b.vendor_id
          WHERE b.org_id = $1
            AND b.status = 'open'
            AND (b.total - b.amount_paid) > 0
            AND ((b.total - b.amount_paid) = $2 OR (b.date >= $3 AND b.date <= $4))
          ORDER BY ((b.total - b.amount_paid) = $2) DESC, b.date DESC, b.id DESC
          LIMIT 200`,
        [currentOrgId(), absAmt, minDate, maxDate]
      )).rows as Array<{ id: number; number: string; date: string; total: number; amountPaid: number; vendorName: string }>;
      for (const bill of candidates) {
        const balance = bill.total - bill.amountPaid; // exact integer cents
        if (balance <= 0) continue;
        const amountClose = balance === absAmt; // exact — integers never drift
        const dateClose = bill.date >= minDate && bill.date <= maxDate;
        if (amountClose || dateClose) {
          let score = 0;
          if (amountClose) score += 50;
          if (dateClose) score += 20;
          if (bill.vendorName && bt.description.toLowerCase().includes(bill.vendorName.toLowerCase())) {
            score += 30;
          }
          if (score > 0) {
            suggestions.push({
              kind: "bill",
              id: bill.id,
              number: bill.number,
              date: bill.date,
              partyName: bill.vendorName || "",
              total: bill.total,
              balance,
              score,
            });
          }
        }
      }
    }
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, 10);
  }

  async matchBankTransaction(input: MatchBankTransactionInput): Promise<BankTransaction> {
    const bt = await this.getBankTransaction(input.bankTransactionId);
    if (!bt) throw new Error("Bank transaction not found");
    if (bt.status === "matched") throw new Error("Already matched");

    // Date-lock check (was missing — categorize/transfer paths could bypass period locks)
    if (input.matchType !== "ignore" && await this.isDateLocked(bt.date)) {
      throw new Error(`Cannot match transaction dated ${bt.date}: that period is closed.`);
    }

    // Resolve the optional payee tag. A vendorId must belong to this org; when
    // supplied without free text, the payee name defaults to the vendor's name.
    let payeeFields: { payee?: string | null; vendorId?: number | null } = {};
    if (input.vendorId != null) {
      const v = await this.getVendor(input.vendorId);
      if (!v) throw new Error(`Vendor #${input.vendorId} not found in this organization`);
      payeeFields = { vendorId: v.id, payee: input.payee ?? v.name };
    } else if (input.payee !== undefined) {
      payeeFields = { payee: input.payee, vendorId: null };
    }

    const absAmt = Math.abs(bt.amount);

    return await db.transaction(async (tx) => {
      let entryId: number | undefined;

      if (input.matchType === "ignore") {
        return tx
          .update(bankTransactions)
          .set({ status: "ignored", ...payeeFields })
          .where(eq(bankTransactions.id, bt.id))
          .returning().then((r) => r[0]);
      }

      if (input.matchType === "invoice_payment") {
        if (!input.invoiceId) throw new Error("invoiceId required");
        if (bt.amount <= 0) throw new Error("Invoice payment requires positive (deposit) amount");
        const inv = await this.payInvoice({
          invoiceId: input.invoiceId,
          date: bt.date,
          amount: absAmt / 100, // payInvoice's boundary expects dollars; ×100 round-trips exactly
          bankAccountId: bt.bankAccountId,
          memo: bt.description,
        });
        const recent = await tx
          .select()
          .from(journalEntries)
          // orgId filter is defense-in-depth: inv is already org-scoped, but
          // source+sourceId alone could collide across tenants if invariants
          // are ever violated — scoping costs nothing and closes the class.
          .where(and(eq(journalEntries.source, "payment"), eq(journalEntries.sourceId, inv.id), eq(journalEntries.orgId, currentOrgId())))
          .orderBy(desc(journalEntries.id))
          .limit(1)
          ;
        entryId = recent[0]?.id;
      } else if (input.matchType === "bill_payment") {
        if (!input.billId) throw new Error("billId required");
        if (bt.amount >= 0) throw new Error("Bill payment requires negative (withdrawal) amount");
        const bill = await this.payBill({
          billId: input.billId,
          date: bt.date,
          amount: absAmt / 100, // payBill's boundary expects dollars; ×100 round-trips exactly
          bankAccountId: bt.bankAccountId,
          memo: bt.description,
        });
        const recent = await tx
          .select()
          .from(journalEntries)
          // orgId filter is defense-in-depth (see invoice_payment branch above).
          .where(and(eq(journalEntries.source, "payment"), eq(journalEntries.sourceId, bill.id), eq(journalEntries.orgId, currentOrgId())))
          .orderBy(desc(journalEntries.id))
          .limit(1)
          ;
        entryId = recent[0]?.id;
      } else if (input.matchType === "categorize") {
        if (!input.categoryAccountId) throw new Error("categoryAccountId required");
        // Validate the category account exists and is not the bank account itself
        const catAcct = await tx.select().from(accounts).where(and(eq(accounts.id, input.categoryAccountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
        if (!catAcct) throw new Error("Category account not found");
        if (catAcct.id === bt.bankAccountId) throw new Error("Category account cannot be the same as the bank account");
        const lines =
          bt.amount > 0
            ? [
                { accountId: bt.bankAccountId, debit: absAmt, credit: 0, description: bt.description },
                { accountId: input.categoryAccountId, debit: 0, credit: absAmt, description: bt.description },
              ]
            : [
                { accountId: input.categoryAccountId, debit: absAmt, credit: 0, description: bt.description },
                { accountId: bt.bankAccountId, debit: 0, credit: absAmt, description: bt.description },
              ];
        const { entry } = await this.postJournalEntry({
          date: bt.date,
          memo: bt.description,
          source: "deposit",
          lines,
        }, { _tx: tx });
        entryId = entry.id;
      } else if (input.matchType === "transfer") {
        if (!input.transferAccountId) throw new Error("transferAccountId required");
        if (input.transferAccountId === bt.bankAccountId) {
          throw new Error("Cannot transfer to the same account");
        }
        // Validate both ends are bank accounts (transfers should not hit non-cash accounts)
        const dst = await tx.select().from(accounts).where(and(eq(accounts.id, input.transferAccountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
        if (!dst) throw new Error("Transfer destination account not found");
        if (dst.subtype !== "bank") {
          throw new Error(`Transfer destination "${dst.name}" must be a bank-subtype account. Use "Categorize" for non-bank movements.`);
        }
        const lines =
          bt.amount > 0
            ? [
                { accountId: bt.bankAccountId, debit: absAmt, credit: 0, description: bt.description },
                { accountId: input.transferAccountId, debit: 0, credit: absAmt, description: bt.description },
              ]
            : [
                { accountId: input.transferAccountId, debit: absAmt, credit: 0, description: bt.description },
                { accountId: bt.bankAccountId, debit: 0, credit: absAmt, description: bt.description },
              ];
        const { entry } = await this.postJournalEntry({
          date: bt.date,
          memo: `Transfer: ${bt.description}`,
          source: "deposit",
          lines,
        }, { _tx: tx });
        entryId = entry.id;
      }

      return tx
        .update(bankTransactions)
        .set({ status: "matched", entryId, ...payeeFields })
        .where(eq(bankTransactions.id, bt.id))
        .returning().then((r) => r[0]);
    });
  }

  // Undo a match or an ignore. Mirrors QBO's "Undo" in the banking tab: the
  // journal entry created by the match is DELETED (not reversed) because it is
  // the unwind of an erroneous match, not a historical business transaction —
  // a reversal pair would leave noise in the GL for something that should never
  // have been posted. The original bank feed row is preserved and returns to
  // "unmatched" so it can be matched correctly.
  async unmatchBankTransaction(id: number): Promise<BankTransaction> {
    const bt = await this.getBankTransaction(id); // org-scoped lookup
    if (!bt) throw new Error("Bank transaction not found");
    if (bt.status !== "matched" && bt.status !== "ignored") {
      throw new Error(`Cannot unmatch: transaction is "${bt.status}" (only matched or ignored transactions can be unmatched).`);
    }

    return await db.transaction(async (tx) => {
      // Ignored rows never created a JE — just flip the status back.
      if (bt.status === "ignored") {
        const row = await tx
          .update(bankTransactions)
          .set({ status: "unmatched" })
          .where(and(eq(bankTransactions.id, bt.id), eq(bankTransactions.orgId, currentOrgId())))
          .returning().then((r) => r[0]);
        await this.audit("unmatch", "bank_transaction", id, `Un-ignored bank transaction "${bt.description}" (${bt.date})`);
        return row;
      }

      // Matched: unwind the journal entry (if one exists).
      if (bt.entryId) {
        const entry = await tx
          .select()
          .from(journalEntries)
          .where(and(eq(journalEntries.id, bt.entryId), eq(journalEntries.orgId, currentOrgId())))
          .then((r: any[]) => r[0]);

        if (entry) {
          // Period-lock check BEFORE any mutation — deleting a JE in a closed
          // period would silently change closed-period balances.
          if (await this.isDateLocked(entry.date)) {
            throw new Error("Cannot unmatch: the matched entry falls in a closed period.");
          }

          const entryLines = await tx
            .select()
            .from(journalLines)
            .where(eq(journalLines.entryId, entry.id));

          // If the match paid an invoice/bill (source "payment"), reverse the
          // payment on the document too — otherwise amountPaid/status would
          // claim money that no longer exists in the GL.
          if (entry.source === "payment" && entry.sourceId) {
            // The payment amount is whatever hit the matched bank account's line:
            // invoice payments DEBIT the bank line, bill payments CREDIT it.
            const bankLine = entryLines.find((l) => l.accountId === bt.bankAccountId);
            const paymentAmount = bankLine ? (bankLine.debit || bankLine.credit || 0) : 0;
            if (paymentAmount <= 0) {
              throw new Error("Cannot unmatch: could not determine the payment amount from the journal entry.");
            }

            if (bt.amount > 0) {
              // Deposit → this was an invoice payment (invoice_payment match).
              const inv = await tx
                .select()
                .from(invoices)
                .where(and(eq(invoices.id, entry.sourceId), eq(invoices.orgId, currentOrgId())))
                .then((r: any[]) => r[0]);
              if (!inv) throw new Error("Cannot unmatch: the paid invoice no longer exists.");
              const newPaid = inv.amountPaid - paymentAmount;
              if (newPaid < 0) {
                // amountPaid below zero means the books were edited outside this
                // flow — refuse rather than corrupt further.
                throw new Error(
                  `Cannot unmatch: reversing ${formatMoney(paymentAmount)} would make invoice ${inv.number}'s paid amount negative (currently ${formatMoney(inv.amountPaid)}). The invoice has been modified since this match.`
                );
              }
              await tx
                .update(invoices)
                .set({ amountPaid: newPaid, status: newPaid >= inv.total ? "paid" : "open" })
                .where(eq(invoices.id, inv.id));
            } else {
              // Withdrawal → this was a bill payment (bill_payment match).
              const bill = await tx
                .select()
                .from(bills)
                .where(and(eq(bills.id, entry.sourceId), eq(bills.orgId, currentOrgId())))
                .then((r: any[]) => r[0]);
              if (!bill) throw new Error("Cannot unmatch: the paid bill no longer exists.");
              const newPaid = bill.amountPaid - paymentAmount;
              if (newPaid < 0) {
                throw new Error(
                  `Cannot unmatch: reversing ${formatMoney(paymentAmount)} would make bill ${bill.number}'s paid amount negative (currently ${formatMoney(bill.amountPaid)}). The bill has been modified since this match.`
                );
              }
              await tx
                .update(bills)
                .set({ amountPaid: newPaid, status: newPaid >= bill.total ? "paid" : "open" })
                .where(eq(bills.id, bill.id));
            }
          }

          // Delete lines first (FK fk_journal_lines_entry would also cascade,
          // but explicit ordering keeps this correct on databases where the FK
          // migration hasn't run yet), then the entry.
          await tx.delete(journalLines).where(eq(journalLines.entryId, entry.id));
          await tx.delete(journalEntries).where(eq(journalEntries.id, entry.id));
        }
      }

      const row = await tx
        .update(bankTransactions)
        .set({ status: "unmatched", entryId: null })
        .where(and(eq(bankTransactions.id, bt.id), eq(bankTransactions.orgId, currentOrgId())))
        .returning().then((r) => r[0]);
      await this.audit(
        "unmatch", "bank_transaction", id,
        `Unmatched bank transaction "${bt.description}" (${bt.date}, ${formatMoney(bt.amount)}); matched journal entry removed`
      );
      return row;
    });
  }

  // ============================================================================
  // BANK RULES
  // ============================================================================
  async listBankRules(): Promise<BankRule[]> {
    return await db.select().from(bankRules).where(eq(bankRules.orgId, currentOrgId())).orderBy(bankRules.priority, bankRules.id);
  }
  async getBankRule(id: number): Promise<BankRule | undefined> {
    return await db.select().from(bankRules).where(and(eq(bankRules.id, id), eq(bankRules.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async createBankRule(input: BankRuleInput): Promise<BankRule> {
    await this.validateBankRuleAccounts(input);
    return db
      .insert(bankRules)
      .values({
          orgId: currentOrgId(),
        name: input.name,
        priority: input.priority ?? 100,
        isActive: input.isActive ?? true,
        bankAccountId: input.bankAccountId ?? null,
        descriptionContains: input.descriptionContains ?? null,
        amountComparator: input.amountComparator ?? null,
        // Rule thresholds are money — stored as integer cents like everything else
        amountMin: input.amountMin != null ? toCents(input.amountMin) : null,
        amountMax: input.amountMax != null ? toCents(input.amountMax) : null,
        direction: input.direction ?? null,
        actionType: input.actionType,
        categoryAccountId: input.categoryAccountId ?? null,
        transferAccountId: input.transferAccountId ?? null,
        payeeVendorId: input.payeeVendorId ?? null,
        autoPost: input.autoPost ?? true,
      })
      .returning().then((r) => r[0]);
  }
  async updateBankRule(id: number, data: Partial<BankRuleInput>): Promise<BankRule> {
    const existing = await this.getBankRule(id);
    if (!existing) throw new Error("Rule not found");
    await this.validateBankRuleAccounts(data);
    // Re-check the cross-field invariants against the merged record so a PATCH
    // can never leave a rule in an unusable state (e.g. actionType flipped to
    // "categorize" without a category account).
    const merged = { ...existing, ...data };
    if (merged.actionType === "categorize" && !merged.categoryAccountId) {
      throw new Error("categoryAccountId is required when actionType is 'categorize'");
    }
    if (merged.actionType === "transfer" && !merged.transferAccountId) {
      throw new Error("transferAccountId is required when actionType is 'transfer'");
    }
    const patch: any = { ...data };
    if (patch.amountMin != null) patch.amountMin = toCents(patch.amountMin);
    if (patch.amountMax != null) patch.amountMax = toCents(patch.amountMax);
    await db.update(bankRules).set(patch).where(and(eq(bankRules.id, id), eq(bankRules.orgId, currentOrgId())));
    const r = await this.getBankRule(id);
    if (!r) throw new Error("Rule not found");
    return r;
  }
  async deleteBankRule(id: number) {
    const existing = await this.getBankRule(id);
    if (!existing) throw new Error("Rule not found");
    return await db.delete(bankRules).where(and(eq(bankRules.id, id), eq(bankRules.orgId, currentOrgId())));
  }
  // Referenced accounts must belong to the active org.
  // Async because getAccount() is async — the old sync version checked truthiness of
  // a Promise (always truthy) and never actually validated anything.
  private async validateBankRuleAccounts(input: Partial<BankRuleInput>): Promise<void> {
    for (const key of ["bankAccountId", "categoryAccountId", "transferAccountId"] as const) {
      const v = input[key];
      if (v !== undefined && v !== null) {
        const acct = await this.getAccount(v);
        if (!acct) throw new Error(`Account ${v} (${key}) not found`);
      }
    }
    // The payee vendor, when set, must be a vendor in this org.
    if (input.payeeVendorId !== undefined && input.payeeVendorId !== null) {
      const v = await this.getVendor(input.payeeVendorId);
      if (!v) throw new Error(`Vendor #${input.payeeVendorId} (payeeVendorId) not found in this organization`);
    }
  }

  // Returns the first matching active rule for a bank tx, by ascending priority.
  async findMatchingRule(bt: BankTransaction): Promise<BankRule | null> {
    const rules = await db
      .select()
      .from(bankRules)
      .where(and(eq(bankRules.isActive, true), eq(bankRules.orgId, currentOrgId())))
      .orderBy(bankRules.priority, bankRules.id)
      ;
    for (const r of rules) {
      if (r.bankAccountId !== null && r.bankAccountId !== bt.bankAccountId) continue;
      if (r.descriptionContains) {
        if (!bt.description.toLowerCase().includes(r.descriptionContains.toLowerCase())) continue;
      }
      if (r.direction === "in" && bt.amount <= 0) continue;
      if (r.direction === "out" && bt.amount >= 0) continue;
      if (r.amountComparator) {
        const a = Math.abs(bt.amount);
        const min = r.amountMin ?? 0;
        const max = r.amountMax ?? 0;
        let ok = false;
        switch (r.amountComparator) {
          case "eq": ok = a === min; break; // exact integer cents
          case "gt": ok = a > min; break;
          case "lt": ok = a < min; break;
          case "gte": ok = a >= min; break;
          case "lte": ok = a <= min; break;
          case "between": ok = a >= min && a <= max; break;
        }
        if (!ok) continue;
      }
      return r;
    }
    return null;
  }

  // Apply a rule to an unmatched bank tx. Returns updated bt or null if rule action=ignore handled.
  async applyRuleToTx(rule: BankRule, bt: BankTransaction): Promise<BankTransaction | null> {
    if (bt.status !== "unmatched") return bt;
    if (rule.actionType === "ignore") {
      const updated = await db
        .update(bankTransactions)
        .set({ status: "ignored" })
        .where(and(eq(bankTransactions.id, bt.id), eq(bankTransactions.orgId, currentOrgId())))
        .returning().then((r) => r[0]);
      await db.update(bankRules).set({ hits: rule.hits + 1 }).where(eq(bankRules.id, rule.id));
      return updated;
    }
    if (rule.actionType === "categorize") {
      if (!rule.categoryAccountId) return bt;
      const updated = await this.matchBankTransaction({
        bankTransactionId: bt.id,
        matchType: "categorize",
        categoryAccountId: rule.categoryAccountId,
        // Auto-tag the payee (vendor) if the rule specifies one.
        vendorId: rule.payeeVendorId ?? undefined,
      });
      await db.update(bankRules).set({ hits: rule.hits + 1 }).where(eq(bankRules.id, rule.id));
      return updated;
    }
    if (rule.actionType === "transfer") {
      if (!rule.transferAccountId) return bt;
      const updated = await this.matchBankTransaction({
        bankTransactionId: bt.id,
        matchType: "transfer",
        transferAccountId: rule.transferAccountId,
      });
      await db.update(bankRules).set({ hits: rule.hits + 1 }).where(eq(bankRules.id, rule.id));
      return updated;
    }
    return bt;
  }

  // Run rules against all unmatched bank txs. Returns count auto-applied.
  async applyRulesToUnmatched(bankAccountId?: number): Promise<{ matched: number; failed: number; errors: string[] }> {
    const txs = bankAccountId
      ? await db.select().from(bankTransactions).where(and(eq(bankTransactions.status, "unmatched"), eq(bankTransactions.bankAccountId, bankAccountId), eq(bankTransactions.orgId, currentOrgId())))
      : await db.select().from(bankTransactions).where(and(eq(bankTransactions.status, "unmatched"), eq(bankTransactions.orgId, currentOrgId())));
    let matched = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const bt of txs) {
      const rule = await this.findMatchingRule(bt);
      if (rule && rule.autoPost) {
        try {
          await this.applyRuleToTx(rule, bt);
          matched++;
        } catch (e: any) {
          failed++;
          // Keep only the first 10 to avoid an unbounded error array on a broken rule
          if (errors.length < 10) {
            errors.push(`Rule "${rule.name}" failed on tx "${bt.description}" (${bt.date}): ${e?.message || e}`);
          }
        }
      }
    }
    return { matched, failed, errors };
  }

  // ============================================================================
  // PLAID ITEMS — persistent bank connections + sync cursors
  // ============================================================================
  // ============================================================================
  // MULTI-CURRENCY (single-rate model)
  // ============================================================================
  // The GL is 100% base currency. FX documents store foreign cents alongside
  // base cents converted at the DOCUMENT rate; on payment, the difference
  // between base relieved (document rate) and base received (payment rate)
  // posts to 4950 FX Gain / 6950 FX Loss. rate = base units per 1 foreign unit.

  async orgBaseCurrency(): Promise<string> {
    const r = (await pool.query(`SELECT base_currency FROM organizations WHERE id = $1`, [currentOrgId()])).rows[0];
    return (r?.base_currency as string) || "USD";
  }

  // Idempotent per-org seeds for the realized-FX accounts. Called lazily from
  // the FX payment paths so orgs created before this migration self-heal.
  async ensureFxAccounts(): Promise<{ gain: Account; loss: Account }> {
    const orgId = currentOrgId();
    const find = async (code: string) =>
      db.select().from(accounts).where(and(eq(accounts.code, code), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    let gain = await find("4950");
    if (!gain) {
      gain = await db.insert(accounts)
        .values({ orgId, code: "4950", name: "FX Gain", type: "income", subtype: "other_income", description: "Realized foreign-exchange gains", isActive: true })
        .returning().then((r) => r[0]);
    }
    let loss = await find("6950");
    if (!loss) {
      loss = await db.insert(accounts)
        .values({ orgId, code: "6950", name: "FX Loss", type: "expense", subtype: "other_expense", description: "Realized foreign-exchange losses", isActive: true })
        .returning().then((r) => r[0]);
    }
    return { gain, loss };
  }

  async listFxRates(): Promise<Array<{ date: string; fromCode: string; toCode: string; rate: number; source: string | null }>> {
    const rows = (await pool.query(
      `SELECT date, from_code AS "fromCode", to_code AS "toCode", rate, source
         FROM fx_rates WHERE org_id = $1 ORDER BY date DESC, from_code, to_code LIMIT 500`,
      [currentOrgId()]
    )).rows;
    return rows as any[];
  }

  async upsertFxRate(input: { date: string; fromCode: string; toCode: string; rate: number; source?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO fx_rates (org_id, date, from_code, to_code, rate, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, date, from_code, to_code) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source`,
      [currentOrgId(), input.date, input.fromCode, input.toCode, input.rate, input.source ?? "manual"]
    );
    await this.audit("upsert", "fx_rate", null, `FX rate ${input.fromCode}→${input.toCode} @ ${input.rate} for ${input.date}`);
  }

  // Idempotent per-org seeds for the UNREALIZED-FX accounts (distinct from the
  // realized 4950/6950 pair). Mirrors ensureFxAccounts().
  async ensureUnrealizedFxAccounts(): Promise<{ gain: Account; loss: Account }> {
    const orgId = currentOrgId();
    const find = async (code: string) =>
      db.select().from(accounts).where(and(eq(accounts.code, code), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    let gain = await find("4960");
    if (!gain) {
      gain = await db.insert(accounts)
        .values({ orgId, code: "4960", name: "Unrealized FX Gain", type: "income", subtype: "other_income", description: "Unrealized foreign-exchange gains (period-end revaluation)", isActive: true })
        .returning().then((r) => r[0]);
    }
    let loss = await find("6960");
    if (!loss) {
      loss = await db.insert(accounts)
        .values({ orgId, code: "6960", name: "Unrealized FX Loss", type: "expense", subtype: "other_expense", description: "Unrealized foreign-exchange losses (period-end revaluation)", isActive: true })
        .returning().then((r) => r[0]);
    }
    return { gain, loss };
  }

  // Exact-date FX rate lookup (base units per 1 foreign unit). Never guesses a
  // nearby date — a revaluation must use an explicitly recorded period-end rate.
  private async getFxRateExact(fromCode: string, toCode: string, date: string): Promise<number | undefined> {
    const row = (await pool.query(
      `SELECT rate FROM fx_rates WHERE org_id = $1 AND date = $2 AND from_code = $3 AND to_code = $4`,
      [currentOrgId(), date, fromCode, toCode]
    )).rows[0];
    return row ? Number(row.rate) : undefined;
  }

  // ============================================================================
  // FX REVALUATION — period-end unrealized adjustment of OPEN foreign balances
  // ============================================================================
  async listFxRevaluations(limit = 50, offset = 0): Promise<Paginated<FxRevaluation>> {
    const where = eq(fxRevaluations.orgId, currentOrgId());
    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(fxRevaluations).where(where);
    const rows = await db.select().from(fxRevaluations).where(where).orderBy(desc(fxRevaluations.id)).limit(limit).offset(offset);
    return { rows, total, limit, offset };
  }

  async getFxRevaluation(id: number): Promise<(FxRevaluation & { lines: FxRevaluationLine[] }) | undefined> {
    const rev = await db.select().from(fxRevaluations).where(and(eq(fxRevaluations.id, id), eq(fxRevaluations.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!rev) return undefined;
    const lines = await db.select().from(fxRevaluationLines)
      .where(and(eq(fxRevaluationLines.revaluationId, id), eq(fxRevaluationLines.orgId, currentOrgId())))
      .orderBy(fxRevaluationLines.id);
    return { ...rev, lines };
  }

  // Remeasure every OPEN foreign invoice/bill (dated on/before asOfDate) at the
  // as-of-date rate and post ONE adjusting JE for the net difference to the
  // Unrealized FX Gain/Loss accounts against A/R (1100) / A/P (2000). Integer
  // cents, one transaction, respects period locks. A rate must exist for the
  // as-of date for every currency in scope — no guessing.
  async revalueFx(input: RevalueFxInput): Promise<{ revaluation: FxRevaluation; lines: FxRevaluationLine[] }> {
    const orgId = currentOrgId();
    const base = await this.orgBaseCurrency();
    const asOf = input.asOfDate;

    // ---- gather OPEN foreign documents in scope -----------------------------
    type Doc = { docType: "invoice" | "bill"; docId: number; currency: string; foreignOutstanding: number; bookingBase: number };
    const docs: Doc[] = [];

    const openInvoices = await db.select().from(invoices).where(and(
      eq(invoices.orgId, orgId), eq(invoices.status, "open"), ne(invoices.currency, ""), lte(invoices.date, asOf),
      ...(input.currency ? [eq(invoices.currency, input.currency)] : []),
    ));
    for (const iv of openInvoices) {
      if (iv.currency === base) continue;
      const foreignOutstanding = iv.foreignTotal - iv.foreignAmountPaid;
      if (foreignOutstanding <= 0) continue;
      docs.push({ docType: "invoice", docId: iv.id, currency: iv.currency, foreignOutstanding, bookingBase: iv.total - iv.amountPaid });
    }

    const openBills = await db.select().from(bills).where(and(
      eq(bills.orgId, orgId), eq(bills.status, "open"), ne(bills.currency, ""), lte(bills.date, asOf),
      ...(input.currency ? [eq(bills.currency, input.currency)] : []),
    ));
    for (const bl of openBills) {
      if (bl.currency === base) continue;
      const foreignOutstanding = bl.foreignTotal - bl.foreignAmountPaid;
      if (foreignOutstanding <= 0) continue;
      docs.push({ docType: "bill", docId: bl.id, currency: bl.currency, foreignOutstanding, bookingBase: bl.total - bl.amountPaid });
    }

    // ---- resolve a rate for EVERY currency in scope (fail loudly) -----------
    const currencies = [...new Set(docs.map((d) => d.currency))];
    const rateByCurrency = new Map<string, number>();
    for (const cur of currencies) {
      const rate = await this.getFxRateExact(cur, base, asOf);
      if (rate === undefined || !(rate > 0)) {
        throw new Error(`No FX rate for ${cur}→${base} on ${asOf}. Add the period-end rate before revaluing (rates are never guessed).`);
      }
      rateByCurrency.set(cur, rate);
    }

    // ---- accounts -----------------------------------------------------------
    const ar = await db.select().from(accounts).where(and(eq(accounts.code, "1100"), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    const ap = await db.select().from(accounts).where(and(eq(accounts.code, "2000"), eq(accounts.orgId, orgId))).then((r: any[]) => r[0]);
    const { gain, loss } = await this.ensureUnrealizedFxAccounts();

    // ---- compute per-doc diffs + aggregate JE (net debit per account) -------
    const perDoc: Array<Doc & { rate: number; revaluedBase: number; diff: number }> = [];
    const acc = new Map<number, { debit: number; credit: number }>();
    const add = (id: number, debit: number, credit: number) => {
      const e = acc.get(id) ?? { debit: 0, credit: 0 };
      e.debit += debit; e.credit += credit; acc.set(id, e);
    };
    let totalGain = 0, totalLoss = 0;
    for (const d of docs) {
      const rate = rateByCurrency.get(d.currency)!;
      const revaluedBase = Math.round(d.foreignOutstanding * rate);
      const diff = revaluedBase - d.bookingBase; // signed
      perDoc.push({ ...d, rate, revaluedBase, diff });
      if (diff === 0) continue;
      if (d.docType === "invoice") {
        if (!ar) throw new Error("Accounts Receivable account (1100) missing");
        if (diff > 0) { add(ar.id, diff, 0); add(gain.id, 0, diff); totalGain += diff; }
        else { add(ar.id, 0, -diff); add(loss.id, -diff, 0); totalLoss += -diff; }
      } else {
        if (!ap) throw new Error("Accounts Payable account (2000) missing");
        if (diff > 0) { add(ap.id, 0, diff); add(loss.id, diff, 0); totalLoss += diff; } // payable base up = loss
        else { add(ap.id, -diff, 0); add(gain.id, 0, -diff); totalGain += -diff; }       // payable base down = gain
      }
    }

    // Net each account to a single debit OR credit line.
    const jeLines: Array<{ accountId: number; debit: number; credit: number; description: string }> = [];
    for (const [accountId, { debit, credit }] of acc) {
      const net = debit - credit;
      if (net > 0) jeLines.push({ accountId, debit: net, credit: 0, description: `Unrealized FX revaluation ${asOf}` });
      else if (net < 0) jeLines.push({ accountId, debit: 0, credit: -net, description: `Unrealized FX revaluation ${asOf}` });
    }

    // ---- persist run + post JE in one transaction ---------------------------
    return await db.transaction(async (tx) => {
      const rev = await tx.insert(fxRevaluations).values({
        orgId, asOfDate: asOf, currency: input.currency ?? null, status: "posted",
        totalGainCents: totalGain, totalLossCents: totalLoss, createdAt: nowIso(),
      }).returning().then((r: any[]) => r[0]);

      let entryId: number | null = null;
      if (jeLines.length >= 2) {
        const je = await this.postJournalEntry({
          date: asOf,
          memo: `Unrealized FX revaluation ${asOf}${input.currency ? ` (${input.currency})` : ""}`,
          reference: `FXREVAL-${rev.id}`,
          source: "fx_revaluation",
          sourceId: rev.id,
          lines: jeLines,
        }, { _tx: tx });
        entryId = je.entry.id;
        await tx.update(fxRevaluations).set({ entryId }).where(and(eq(fxRevaluations.id, rev.id), eq(fxRevaluations.orgId, orgId)));
      }

      const insertedLines: FxRevaluationLine[] = [];
      for (const d of perDoc) {
        const row = await tx.insert(fxRevaluationLines).values({
          orgId, revaluationId: rev.id, docType: d.docType, docId: d.docId, currency: d.currency,
          rate: d.rate, foreignOutstandingCents: d.foreignOutstanding, bookingBaseCents: d.bookingBase,
          revaluedBaseCents: d.revaluedBase, diffCents: d.diff,
        }).returning().then((r: any[]) => r[0]);
        insertedLines.push(row);
      }
      await this.audit("revalue", "fx_revaluation", rev.id,
        `FX revaluation ${asOf}: ${perDoc.length} document(s), gain ${formatMoney(totalGain)}, loss ${formatMoney(totalLoss)}`,
        { asOfDate: asOf, currency: input.currency ?? null, entryId });
      return { revaluation: { ...rev, entryId }, lines: insertedLines };
    });
  }

  // Reverse a revaluation at the start of the next period (standard practice:
  // unrealized adjustments reverse, realized ones don't). Posts the exact
  // opposite of the adjusting JE, restoring the prior carrying value.
  async reverseFxRevaluation(id: number): Promise<FxRevaluation> {
    const rev = await this.getFxRevaluation(id);
    if (!rev) throw new Error("FX revaluation not found");
    if (rev.status === "reversed") throw new Error(`FX revaluation ${id} has already been reversed.`);
    // First day of the month AFTER the as-of date's period.
    const reversalDate = `${addMonthsToPeriod(periodOf(rev.asOfDate), 1)}-01`;
    if (!rev.entryId) {
      // No adjusting JE was posted (nothing to revalue) — just mark reversed.
      const row = await db.update(fxRevaluations).set({ status: "reversed", reversalDate })
        .where(and(eq(fxRevaluations.id, id), eq(fxRevaluations.orgId, currentOrgId()))).returning().then((r: any[]) => r[0]);
      await this.audit("reverse", "fx_revaluation", id, `Reversed FX revaluation ${id} (no-op — no adjusting entry)`);
      return row;
    }
    // Load the original JE lines and post their mirror image.
    const origLines = await db.select().from(journalLines).where(eq(journalLines.entryId, rev.entryId));
    const reversedLines = origLines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, description: `Reversal of FX revaluation ${rev.asOfDate}` }));
    return await db.transaction(async (tx) => {
      const je = await this.postJournalEntry({
        date: reversalDate,
        memo: `Reversal of unrealized FX revaluation ${rev.asOfDate}`,
        reference: `FXREVAL-${rev.id}-REV`,
        source: "fx_revaluation_reversal",
        sourceId: rev.id,
        lines: reversedLines,
      }, { _tx: tx });
      const row = await tx.update(fxRevaluations)
        .set({ status: "reversed", reversalEntryId: je.entry.id, reversalDate })
        .where(and(eq(fxRevaluations.id, id), eq(fxRevaluations.orgId, currentOrgId()))).returning().then((r: any[]) => r[0]);
      await this.audit("reverse", "fx_revaluation", id, `Reversed FX revaluation ${rev.asOfDate} on ${reversalDate}`);
      return row;
    });
  }

  // Resolves currency/fxRate for a new document. Returns null for base-currency
  // documents; throws when a foreign currency is given without a valid rate.
  private async resolveDocumentFx(currency?: string, fxRate?: number): Promise<{ currency: string; fxRate: number } | null> {
    const base = await this.orgBaseCurrency();
    if (!currency || currency === base) return null;
    if (!fxRate || !(fxRate > 0)) {
      throw new Error(`fxRate is required (and must be > 0) for ${currency} documents — the org base currency is ${base}.`);
    }
    return { currency, fxRate };
  }

  // ============================================================================
  // NUMBER SEQUENCES — per-org auto-numbering (invoice/bill/credit_note/debit_note)
  // ============================================================================
  // RACE SAFETY: allocation is ONE atomic statement. INSERT..ON CONFLICT DO
  // UPDATE takes a row-level lock on the (org_id, kind) row, so two concurrent
  // allocators serialize on that lock and each RETURNING sees a distinct
  // next_value — no read-modify-write window, no duplicates, no app-level
  // locking needed. Numbers allocated for a create that later fails are simply
  // burned; numbering gaps are acceptable for these document types.
  private static readonly SEQUENCE_DEFAULTS: Record<string, { prefix: string; padding: number }> = {
    invoice: { prefix: "INV-", padding: 4 },
    bill: { prefix: "BILL-", padding: 4 },
    credit_note: { prefix: "CN-", padding: 4 },
    debit_note: { prefix: "DN-", padding: 4 },
    purchase_order: { prefix: "PO-", padding: 4 },
    estimate: { prefix: "EST-", padding: 4 },
  };

  async nextNumber(kind: "invoice" | "bill" | "credit_note" | "debit_note" | "purchase_order" | "estimate"): Promise<string> {
    const def = DatabaseStorage.SEQUENCE_DEFAULTS[kind];
    if (!def) throw new Error(`Unknown sequence kind "${kind}"`);
    // Insert path: this call allocates 1, so the stored next_value becomes 2.
    // Update path: bump next_value by 1. Either way the allocated number is
    // (returned next_value - 1).
    const row = (await pool.query(
      `INSERT INTO number_sequences (org_id, kind, prefix, next_value, padding)
       VALUES ($1, $2, $3, 2, $4)
       ON CONFLICT (org_id, kind) DO UPDATE
         SET next_value = number_sequences.next_value + 1
       RETURNING prefix, next_value, padding`,
      [currentOrgId(), kind, def.prefix, def.padding]
    )).rows[0] as { prefix: string; next_value: number; padding: number };
    const allocated = Number(row.next_value) - 1;
    return `${row.prefix}${String(allocated).padStart(Number(row.padding), "0")}`;
  }

  // Read-only PREVIEW of the upcoming number — does NOT increment. The UI uses
  // this to prefill the form; the authoritative allocation happens at create.
  async previewNextNumber(kind: "invoice" | "bill" | "credit_note" | "debit_note" | "purchase_order" | "estimate"): Promise<{ kind: string; next: string }> {
    const def = DatabaseStorage.SEQUENCE_DEFAULTS[kind];
    if (!def) throw new Error(`Unknown sequence kind "${kind}"`);
    const row = (await pool.query(
      `SELECT prefix, next_value, padding FROM number_sequences WHERE org_id = $1 AND kind = $2`,
      [currentOrgId(), kind]
    )).rows[0] as { prefix: string; next_value: number; padding: number } | undefined;
    const prefix = row?.prefix ?? def.prefix;
    const padding = Number(row?.padding ?? def.padding);
    const upcoming = Number(row?.next_value ?? 1);
    return { kind, next: `${prefix}${String(upcoming).padStart(padding, "0")}` };
  }

  async savePlaidItem(input: {
    bankAccountId: number;
    accessToken: string;
    itemId: string;
    institutionName?: string;
  }): Promise<{ id: number }> {
    const orgId = currentOrgId();
    // Encrypt at rest (Task: AES-256-GCM vault). Plaintext never touches the DB
    // when a key is configured; production refuses to boot without one.
    const storedToken = encryptSecret(input.accessToken);
    // Idempotent on item_id: if Plaid returned the same item, just update the token.
    const existing = (await pool.query(`SELECT id FROM plaid_items WHERE item_id = $1 AND org_id = $2`, [input.itemId, orgId])).rows[0] as { id: number } | undefined;
    if (existing) {
      await pool.query(`UPDATE plaid_items SET access_token = $1, bank_account_id = $2, institution_name = COALESCE($3, institution_name) WHERE id = $4 AND org_id = $5`, [storedToken, input.bankAccountId, input.institutionName ?? null, existing.id, orgId]);
      return { id: existing.id };
    }
    const r = await pool.query(`INSERT INTO plaid_items (org_id, bank_account_id, item_id, access_token, institution_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, input.bankAccountId, input.itemId, storedToken, input.institutionName ?? null]);
    return { id: Number(r.rows[0].id) };
  }

  async listPlaidItems(): Promise<Array<{
    id: number;
    bankAccountId: number;
    itemId: string;
    institutionName?: string;
    cursor?: string;
    lastSyncAt?: string;
    lastSyncError?: string;
  }>> {
    const rows = (await pool.query(`SELECT id, bank_account_id AS "bankAccountId", item_id AS "itemId",
                institution_name AS "institutionName", cursor,
                last_sync_at AS "lastSyncAt", last_sync_error AS "lastSyncError"
         FROM plaid_items WHERE org_id = $1
         ORDER BY id`, [currentOrgId()])).rows;
    return rows as any;
  }

  async getPlaidItemAccessToken(id: number): Promise<{ accessToken: string; cursor: string | null; bankAccountId: number } | undefined> {
    const r = (await pool.query(`SELECT access_token AS "accessToken", cursor, bank_account_id AS "bankAccountId" FROM plaid_items WHERE id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0] as any;
    if (!r) return undefined;
    // LAZY MIGRATION (self-healing, no bulk script): rows written before the
    // encryption vault shipped hold plaintext tokens (no "v1:" prefix). On the
    // first read of such a row we immediately re-write it encrypted, so the
    // fleet converges to encrypted-at-rest through normal usage. If encryption
    // is unavailable (non-production without a key), we leave the row as-is.
    if (isLegacyPlaintext(r.accessToken) && encryptionAvailable()) {
      const encrypted = encryptSecret(r.accessToken);
      await pool.query(`UPDATE plaid_items SET access_token = $1 WHERE id = $2 AND org_id = $3`, [encrypted, id, currentOrgId()]);
      // r.accessToken is already the plaintext — return it directly below.
      return { ...r, accessToken: r.accessToken };
    }
    return { ...r, accessToken: decryptSecret(r.accessToken) };
  }

  async updatePlaidItemCursor(id: number, cursor: string, error?: string): Promise<void> {
    await pool.query(`UPDATE plaid_items SET cursor = $1, last_sync_at = now(), last_sync_error = $2 WHERE id = $3 AND org_id = $4`, [cursor, error ?? null, id, currentOrgId()]);
  }

  async deletePlaidItem(id: number): Promise<void> {
    const r = await pool.query(`DELETE FROM plaid_items WHERE id = $1 AND org_id = $2`, [id, currentOrgId()]);
    if ((r.rowCount ?? 0) === 0) throw new Error("Plaid item not found");
  }

  // ============================================================================
  // RECONCILIATION
  // ============================================================================
  async listReconciliations(bankAccountId?: number): Promise<Reconciliation[]> {
    if (bankAccountId) {
      return db
        .select()
        .from(reconciliations)
        .where(and(eq(reconciliations.bankAccountId, bankAccountId), eq(reconciliations.orgId, currentOrgId())))
        .orderBy(desc(reconciliations.statementDate))
        ;
    }
    return await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.orgId, currentOrgId()))
      .orderBy(desc(reconciliations.statementDate));
  }

  async getReconciliation(id: number) {
    // Org-scoped lookup: reconciliation IDs are a GLOBAL sequence, so an id
    // alone is guessable across tenants — without this filter a user in Org A
    // could read Org B's reconciliation (and its bank transactions) via
    // GET /api/reconciliations/:id. completeReconciliation() calls this method,
    // so the fix covers that route too. (Matches deleteReconciliation.)
    const recon = await db
      .select()
      .from(reconciliations)
      .where(and(eq(reconciliations.id, id), eq(reconciliations.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!recon) return null;
    const items = await db.select().from(reconciliationItems).where(eq(reconciliationItems.reconciliationId, id));
    const clearedMap = new Map<number, boolean>();
    for (const i of items) clearedMap.set(i.bankTransactionId, i.cleared);

    // Get all bank txs for this account up to statement date (regardless of cleared status)
    const allTxs = await db
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.bankAccountId, recon.bankAccountId),
          eq(bankTransactions.orgId, currentOrgId()),
          lte(bankTransactions.date, recon.statementDate)
        )
      )
      .orderBy(bankTransactions.date, bankTransactions.id)
      ;

    const txs = allTxs.map((t) => ({
      ...t,
      cleared: clearedMap.get(t.id) ?? false,
    }));
    const totals = await this.computeReconTotals(recon, txs);
    return { reconciliation: recon, transactions: txs, totals };
  }

  private computeReconTotals(
    recon: Reconciliation,
    txs: Array<BankTransaction & { cleared: boolean }>
  ) {
    const clearedDeposits = txs.filter((t) => t.cleared && t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const clearedWithdrawals = txs.filter((t) => t.cleared && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    const bookBalance = recon.beginningBalance + clearedDeposits - clearedWithdrawals;
    const difference = bookBalance - recon.endingBalance; // exact integer cents
    return {
      beginningBalance: recon.beginningBalance,
      endingBalance: recon.endingBalance,
      clearedDeposits: clearedDeposits,
      clearedWithdrawals: clearedWithdrawals,
      bookBalance: bookBalance,
      difference,
    };
  }

  async startReconciliation(input: StartReconciliationInput): Promise<Reconciliation> {
    // Validate the account exists and is a bank account
    const acct = await db.select().from(accounts).where(and(eq(accounts.id, input.bankAccountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!acct) throw new Error("Bank account not found");
    if (acct.type !== "asset" || acct.subtype !== "bank") {
      throw new Error(`Reconciliation only valid for bank-subtype accounts (got ${acct.type}/${acct.subtype || "no subtype"}).`);
    }
    // Prevent two open reconciliations for the same bank account at once.
    // orgId is defense-in-depth: bankAccountId was validated org-scoped above.
    const existingOpen = await db
      .select()
      .from(reconciliations)
      .where(and(eq(reconciliations.bankAccountId, input.bankAccountId), eq(reconciliations.status, "in_progress"), eq(reconciliations.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (existingOpen) {
      throw new Error(
        `Reconciliation already in progress for this account (started ${existingOpen.statementDate}). Complete or delete it first.`
      );
    }
    return db
      .insert(reconciliations)
      .values({
          orgId: currentOrgId(),
        bankAccountId: input.bankAccountId,
        statementDate: input.statementDate,
        beginningBalance: toCents(input.beginningBalance), // user dollars → integer cents
        endingBalance: toCents(input.endingBalance),
        status: "in_progress",
      })
      .returning().then((r) => r[0]);
  }

  async toggleReconItem(reconId: number, bankTransactionId: number, cleared: boolean): Promise<ReconciliationItem> {
    // Org-scoped lookup: without this filter a user could toggle clearing
    // status on ANOTHER tenant's reconciliation (a cross-tenant WRITE) via
    // POST /api/reconciliations/:id/toggle, since ids are a global sequence.
    const recon = await db
      .select()
      .from(reconciliations)
      .where(and(eq(reconciliations.id, reconId), eq(reconciliations.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!recon) throw new Error("Reconciliation not found");
    if (recon.status === "completed") throw new Error("Reconciliation already completed");

    const existing = await db
      .select()
      .from(reconciliationItems)
      .where(
        and(
          eq(reconciliationItems.reconciliationId, reconId),
          eq(reconciliationItems.bankTransactionId, bankTransactionId)
        )
      )
      .then((r: any[]) => r[0]);
    if (existing) {
      return db
        .update(reconciliationItems)
        .set({ cleared })
        .where(eq(reconciliationItems.id, existing.id))
        .returning().then((r) => r[0]);
    }
    // orgId set EXPLICITLY: the column's old DB default of 1 silently tagged
    // every tenant's items as org 1. Migration 0003 backfills legacy rows and
    // drops that default so a missing orgId now fails loudly instead.
    return db
      .insert(reconciliationItems)
      .values({ orgId: currentOrgId(), reconciliationId: reconId, bankTransactionId, cleared })
      .returning().then((r) => r[0]);
  }

  async completeReconciliation(id: number): Promise<Reconciliation> {
    const result = await this.getReconciliation(id);
    if (!result) throw new Error("Reconciliation not found");
    if (result.reconciliation.status === "completed") {
      throw new Error("Already completed");
    }
    if (result.totals.difference !== 0) { // EXACT — integers make this a hard equality
      throw new Error(`Cannot complete: difference is ${formatMoney(result.totals.difference)}, must be $0.00`);
    }
    return db
      .update(reconciliations)
      .set({ status: "completed", completedAt: new Date().toISOString() })
      .where(eq(reconciliations.id, id))
      .returning().then((r) => r[0]);
  }

  // Abandon an in-progress reconciliation. Completed reconciliations are
  // immutable history — they document that the books matched the bank
  // statement at a point in time — so they can never be deleted.
  async deleteReconciliation(id: number): Promise<{ ok: true }> {
    const recon = await db
      .select()
      .from(reconciliations)
      .where(and(eq(reconciliations.id, id), eq(reconciliations.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!recon) throw new Error("Reconciliation not found");
    if (recon.status !== "in_progress") {
      throw new Error("Completed reconciliations cannot be deleted");
    }
    await db.transaction(async (tx) => {
      await tx.delete(reconciliationItems).where(eq(reconciliationItems.reconciliationId, id));
      await tx.delete(reconciliations).where(eq(reconciliations.id, id));
    });
    await this.audit(
      "delete", "reconciliation", id,
      `Abandoned in-progress reconciliation (statement ${recon.statementDate}, account #${recon.bankAccountId})`
    );
    return { ok: true };
  }

  // ============================================================================
  // RECURRING TRANSACTIONS
  // ============================================================================
  private advanceDate(dateStr: string, freq: string, n: number): string {
    const d = new Date(dateStr + "T00:00:00Z");
    if (freq === "daily") {
      d.setUTCDate(d.getUTCDate() + n);
    } else if (freq === "weekly") {
      d.setUTCDate(d.getUTCDate() + n * 7);
    } else if (freq === "monthly") {
      const targetDay = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n);
      // Clamp to last day of new month
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(targetDay, lastDay));
    } else if (freq === "yearly") {
      d.setUTCFullYear(d.getUTCFullYear() + n);
    }
    return d.toISOString().slice(0, 10);
  }

  async listRecurring(): Promise<RecurringTemplate[]> {
    return await db
      .select()
      .from(recurringTemplates)
      .where(eq(recurringTemplates.orgId, currentOrgId()))
      .orderBy(recurringTemplates.nextRunDate);
  }
  // Invoices generated by a recurring template (recorded via recurringTemplateId).
  async listInvoicesForRecurring(templateId: number): Promise<Invoice[]> {
    return await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.recurringTemplateId, templateId), eq(invoices.orgId, currentOrgId())))
      .orderBy(desc(invoices.date), desc(invoices.id));
  }
  async getRecurring(id: number): Promise<RecurringTemplate | undefined> {
    return await db.select().from(recurringTemplates).where(and(eq(recurringTemplates.id, id), eq(recurringTemplates.orgId, currentOrgId()))).then((r: any[]) => r[0]);
  }
  async createRecurring(input: CreateRecurringInput): Promise<RecurringTemplate> {
    await this.validateRecurringPayload(input.kind, input.payload);
    return db
      .insert(recurringTemplates)
      .values({
          orgId: currentOrgId(),
        name: input.name,
        kind: input.kind,
        frequency: input.frequency,
        intervalCount: input.intervalCount ?? 1,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        maxOccurrences: input.maxOccurrences ?? null,
        nextRunDate: input.startDate,
        isActive: input.isActive ?? true,
        payload: JSON.stringify(input.payload),
      })
      .returning().then((r) => r[0]);
  }
  async updateRecurring(id: number, data: Partial<CreateRecurringInput>): Promise<RecurringTemplate> {
    const existing = await this.getRecurring(id);
    if (!existing) throw new Error("Template not found");
    const updates: any = { ...data };
    if (data.payload !== undefined) {
      const kind = data.kind ?? existing.kind;
      await this.validateRecurringPayload(kind, data.payload);
      updates.payload = JSON.stringify(data.payload);
    }
    // Validate the merged date window
    const start = data.startDate ?? existing.startDate;
    const end = data.endDate !== undefined ? data.endDate : existing.endDate;
    if (end && start && end < start) throw new Error("End date must be on or after start date");
    await db.update(recurringTemplates).set(updates).where(and(eq(recurringTemplates.id, id), eq(recurringTemplates.orgId, currentOrgId())));
    const r = await this.getRecurring(id);
    if (!r) throw new Error("Template not found");
    return r;
  }
  async deleteRecurring(id: number) {
    const existing = await this.getRecurring(id);
    if (!existing) throw new Error("Template not found");
    return await db.delete(recurringTemplates).where(and(eq(recurringTemplates.id, id), eq(recurringTemplates.orgId, currentOrgId())));
  }

  // Per-kind payload validation — runs at create AND update time so a malformed
  // payload is caught immediately, not on the next scheduler run when it would
  // throw mid-postRecurringOccurrence and break the whole catch-up batch.
  private async validateRecurringPayload(kind: string, payload: any) {
    if (!payload || typeof payload !== "object") throw new Error("payload is required");
    if (kind === "invoice") {
      if (!payload.customerId || typeof payload.customerId !== "number")
        throw new Error("Invoice template requires numeric customerId");
      const cust = await db.select().from(customers).where(and(eq(customers.id, payload.customerId), eq(customers.orgId, currentOrgId()))).then((r: any[]) => r[0]);
      if (!cust) throw new Error(`Invoice template references missing customer #${payload.customerId}`);
      if (!Array.isArray(payload.lines) || payload.lines.length === 0)
        throw new Error("Invoice template requires at least one line");
      for (const [i, l] of payload.lines.entries()) {
        const acctId = l.incomeAccountId ?? l.accountId;
        if (!acctId) throw new Error(`Line ${i + 1}: incomeAccountId is required`);
        const a = await db.select().from(accounts).where(and(eq(accounts.id, acctId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
        if (!a) throw new Error(`Line ${i + 1}: account #${acctId} not found`);
        if (a.type !== "income") throw new Error(`Line ${i + 1}: "${a.name}" is ${a.type}, expected income`);
        const qty = l.quantity ?? 1;
        const rate = l.rate ?? l.amount ?? 0;
        if (typeof qty !== "number" || qty <= 0) throw new Error(`Line ${i + 1}: quantity must be > 0`);
        if (typeof rate !== "number" || rate < 0) throw new Error(`Line ${i + 1}: rate must be >= 0`);
      }
    } else if (kind === "bill") {
      if (!payload.vendorId || typeof payload.vendorId !== "number")
        throw new Error("Bill template requires numeric vendorId");
      const ven = await db.select().from(vendors).where(and(eq(vendors.id, payload.vendorId), eq(vendors.orgId, currentOrgId()))).then((r: any[]) => r[0]);
      if (!ven) throw new Error(`Bill template references missing vendor #${payload.vendorId}`);
      if (!Array.isArray(payload.lines) || payload.lines.length === 0)
        throw new Error("Bill template requires at least one line");
      for (const [i, l] of payload.lines.entries()) {
        const acctId = l.expenseAccountId ?? l.accountId;
        if (!acctId) throw new Error(`Line ${i + 1}: expenseAccountId is required`);
        const a = await db.select().from(accounts).where(and(eq(accounts.id, acctId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
        if (!a) throw new Error(`Line ${i + 1}: account #${acctId} not found`);
        if (a.type !== "expense") throw new Error(`Line ${i + 1}: "${a.name}" is ${a.type}, expected expense`);
      }
    } else if (kind === "journal") {
      if (!Array.isArray(payload.lines) || payload.lines.length < 2)
        throw new Error("Journal template requires at least 2 lines");
      let totDr = 0, totCr = 0;
      for (const [i, l] of payload.lines.entries()) {
        if (!l.accountId) throw new Error(`Line ${i + 1}: accountId is required`);
        const a = await db.select().from(accounts).where(and(eq(accounts.id, l.accountId), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
        if (!a) throw new Error(`Line ${i + 1}: account #${l.accountId} not found`);
        const dr = +(l.debit || 0);
        const cr = +(l.credit || 0);
        if (dr > 0 && cr > 0) throw new Error(`Line ${i + 1}: cannot have both debit and credit`);
        if (dr === 0 && cr === 0) throw new Error(`Line ${i + 1}: must have a debit or credit > 0`);
        totDr += dr;
        totCr += cr;
      }
      if (totDr !== totCr) { // exact integer equality
        throw new Error(`Journal template debits (${formatMoney(totDr)}) ≠ credits (${formatMoney(totCr)})`);
      }
    } else {
      throw new Error(`Unknown recurring kind: ${kind}`);
    }
  }

  // Best-effort: email a (generated) invoice to its customer when SMTP is
  // configured. NEVER throws — a send failure must not break recurring
  // catch-up, and the invoice is already committed. Returns a small result for
  // logging/tests. When SMTP is unconfigured it is a graceful no-op.
  async emailInvoiceToCustomer(invoiceId: number): Promise<{ emailed: boolean; reason?: string; mode?: string }> {
    try {
      if (!smtpStatus().configured) return { emailed: false, reason: "smtp-not-configured" };
      const inv = await this.getInvoice(invoiceId);
      if (!inv) return { emailed: false, reason: "invoice-not-found" };
      const to = inv.customer?.email || undefined;
      if (!to) return { emailed: false, reason: "no-customer-email" };
      const share = await this.createInvoiceShare(invoiceId, to);
      const url = `${appBaseUrl()}/p/invoice/${share.token}`;
      const customerName = inv.customer?.name || "there";
      const amountDue = inv.total - (inv.amountPaid || 0);
      const text = [
        `Hi ${customerName},`, ``,
        `Your invoice ${inv.number} is ready.`, ``,
        `  Amount due: ${formatMoney(amountDue)}`,
        `  Due date:   ${inv.dueDate}`, ``,
        `View invoice online: ${url}`,
        `Download PDF:        ${url}/pdf`, ``,
        `Thank you for your business,`, `LedgerLite`,
      ].join("\n");
      const html = `<p>Hi ${customerName},</p><p>Your invoice <strong>${inv.number}</strong> is ready.</p>`
        + `<ul><li>Amount due: <strong>${formatMoney(amountDue)}</strong></li><li>Due date: ${inv.dueDate}</li></ul>`
        + `<p><a href="${url}">View invoice</a> &nbsp; <a href="${url}/pdf">Download PDF</a></p><p>Thanks,<br/>LedgerLite</p>`;
      const sendResult = await sendEmail({ to, subject: `Invoice ${inv.number} from LedgerLite`, text, html });
      await this.markShareSent(share.id, sendResult.ok ? "sent" : "failed", sendResult.ok ? undefined : sendResult.error);
      await this.audit("send", "invoice", invoiceId, `Emailed invoice ${inv.number} to ${to}`, { shareId: share.id, mode: sendResult.mode });
      return { emailed: sendResult.ok, mode: sendResult.mode };
    } catch (e: any) {
      logger.warn("[recurring] invoice email failed", { invoiceId, error: e?.message });
      return { emailed: false, reason: e?.message };
    }
  }

  private async postRecurringOccurrence(t: RecurringTemplate): Promise<{ kind: string; id: number; emailed?: boolean }> {
    const payload = JSON.parse(t.payload);
    const today = t.nextRunDate;
    if (t.kind === "invoice") {
      const due = await this.advanceDate(today, "daily", payload.dueDateOffsetDays ?? 30);
      const num = `REC-INV-${t.id}-${t.occurrencesPosted + 1}`;
      // Map simplified lines {accountId, description, amount} to invoice line shape
      const lines = (payload.lines || []).map((l: any) => ({
        description: l.description ?? "",
        quantity: l.quantity ?? 1,
        rate: l.rate ?? l.amount ?? 0,
        incomeAccountId: l.incomeAccountId ?? l.accountId,
      }));
      const inv = await this.createInvoice({
        number: num,
        customerId: payload.customerId,
        date: today,
        dueDate: due,
        taxRate: payload.taxRate ?? 0,
        notes: payload.notes,
        lines,
      });
      // Record the originating template on the generated invoice.
      await db.update(invoices).set({ recurringTemplateId: t.id })
        .where(and(eq(invoices.id, inv.id), eq(invoices.orgId, currentOrgId())));
      // Email the customer if SMTP is configured and the template opts in
      // (default true). Best-effort — never breaks catch-up.
      let emailed = false;
      if (payload.autoEmail !== false) {
        emailed = (await this.emailInvoiceToCustomer(inv.id)).emailed;
      }
      return { kind: "invoice", id: inv.id, emailed };
    }
    if (t.kind === "bill") {
      const due = await this.advanceDate(today, "daily", payload.dueDateOffsetDays ?? 30);
      const num = `REC-BILL-${t.id}-${t.occurrencesPosted + 1}`;
      const lines = (payload.lines || []).map((l: any) => ({
        description: l.description ?? "",
        quantity: l.quantity ?? 1,
        rate: l.rate ?? l.amount ?? 0,
        expenseAccountId: l.expenseAccountId ?? l.accountId,
      }));
      const bill = await this.createBill({
        number: num,
        vendorId: payload.vendorId,
        date: today,
        dueDate: due,
        taxRate: payload.taxRate ?? 0,
        notes: payload.notes,
        lines,
      });
      return { kind: "bill", id: bill.id };
    }
    if (t.kind === "journal") {
      // Journal lines use {accountId, debit, credit, description}. The payload
      // stores the amounts as the user typed them (dollars) — convert to
      // integer cents at posting time, the same boundary as the JE route.
      const { entry } = await this.postJournalEntry({
        date: today,
        memo: payload.memo ?? t.name,
        reference: `REC-JE-${t.id}-${t.occurrencesPosted + 1}`,
        source: "recurring",
        sourceId: t.id,
        lines: (payload.lines || []).map((l: any) => ({
          ...l,
          debit: toCents(l.debit || 0),
          credit: toCents(l.credit || 0),
        })),
      });
      return { kind: "journal", id: entry.id };
    }
    throw new Error(`Unknown recurring kind: ${t.kind}`);
  }

  async runCatchUp(asOfDate?: string): Promise<Array<{ templateId: number; templateName: string; posted: number; results: any[] }>> {
    const today = asOfDate || new Date().toISOString().slice(0, 10);
    const due = await db
      .select()
      .from(recurringTemplates)
      .where(
        and(eq(recurringTemplates.isActive, true), lte(recurringTemplates.nextRunDate, today))
      )
      ;
    const out: Array<{ templateId: number; templateName: string; posted: number; results: any[] }> = [];

    for (const t of due) {
      // Catch-up runs at server boot, outside any request/org context. Each
      // template posts inside its OWN org's context so invoices/JEs land in
      // the right tenant's books.
      await withOrg({ orgId: t.orgId, userId: 0 }, async () => {
      let template = t;
      const results: any[] = [];
      // Catch up: post all occurrences whose nextRunDate <= today
      let safety = 0;
      while (
        template.isActive &&
        template.nextRunDate <= today &&
        (!template.endDate || template.nextRunDate <= template.endDate) &&
        (!template.maxOccurrences || template.occurrencesPosted < template.maxOccurrences) &&
        safety < 200
      ) {
        safety++;
        try {
          const posted = await this.postRecurringOccurrence(template);
          results.push(posted);
          const newOccurrences = template.occurrencesPosted + 1;
          const newNext = await this.advanceDate(template.nextRunDate, template.frequency, template.intervalCount);
          let stillActive = true;
          if (template.endDate && newNext > template.endDate) stillActive = false;
          if (template.maxOccurrences && newOccurrences >= template.maxOccurrences) stillActive = false;
          await db.update(recurringTemplates)
            .set({
              occurrencesPosted: newOccurrences,
              nextRunDate: newNext,
              lastRunAt: new Date().toISOString(),
              isActive: stillActive,
            })
            .where(eq(recurringTemplates.id, template.id))
            ;
          template = (await this.getRecurring(template.id))!;
        } catch (e: any) {
          logger.error("Recurring run failed for template", { templateId: template.id, error: e.message });
          break;
        }
      }
      if (results.length > 0) {
        out.push({ templateId: t.id, templateName: t.name, posted: results.length, results });
      }
      });
    }
    return out;
  }

  // Run a single template once (regardless of nextRunDate)
  async runRecurringOnce(id: number) {
    const t = await this.getRecurring(id);
    if (!t) throw new Error("Template not found");
    if (!t.isActive) throw new Error("Template is not active");
    const posted = await this.postRecurringOccurrence(t);
    const newOccurrences = t.occurrencesPosted + 1;
    const newNext = await this.advanceDate(t.nextRunDate, t.frequency, t.intervalCount);
    let stillActive = true;
    if (t.endDate && newNext > t.endDate) stillActive = false;
    if (t.maxOccurrences && newOccurrences >= t.maxOccurrences) stillActive = false;
    await db.update(recurringTemplates)
      .set({
        occurrencesPosted: newOccurrences,
        nextRunDate: newNext,
        lastRunAt: new Date().toISOString(),
        isActive: stillActive,
      })
      .where(eq(recurringTemplates.id, id))
      ;
    return posted;
  }

  // ============================================================================
  // BATCH RECLASSIFY
  // ============================================================================
  // Strategy: directly UPDATE journal_lines.account_id to the new account.
  // Post a single audit journal_entries row (zero-line) noting the reclassification.
  async reclassifyLines(input: ReclassifyInput): Promise<{ linesUpdated: number; entryId: number; lineIds: number[] }> {
    return await db.transaction(async (tx) => {
      // Resolve target line IDs
      let targetIds: number[] = [];
      if (input.lineIds && input.lineIds.length > 0) {
        // Only accept line IDs whose parent entry belongs to the active org —
        // otherwise a caller could reclassify another tenant's ledger.
        const owned = await tx
          .select({ id: journalLines.id })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
          .where(and(inArray(journalLines.id, input.lineIds), eq(journalEntries.orgId, currentOrgId())));
        targetIds = owned.map((r) => r.id);
        if (targetIds.length !== input.lineIds.length) {
          throw new Error("One or more journal lines were not found");
        }
      } else if (input.filter) {
        const f = input.filter;
        const rows = await tx
          .select({ line: journalLines, entry: journalEntries })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
          .where(and(eq(journalLines.accountId, f.fromAccountId), eq(journalEntries.orgId, currentOrgId())))
          ;
        targetIds = rows
          .filter((r) => {
            if (f.fromDate && r.entry.date < f.fromDate) return false;
            if (f.toDate && r.entry.date > f.toDate) return false;
            if (f.side === "debit" && r.line.debit <= 0) return false;
            if (f.side === "credit" && r.line.credit <= 0) return false;
            if (f.descriptionContains) {
              const desc = (r.line.description || "") + " " + (r.entry.memo || "");
              if (!desc.toLowerCase().includes(f.descriptionContains.toLowerCase())) return false;
            }
            return true;
          })
          .map((r) => r.line.id);
      }
      if (targetIds.length === 0) {
        throw new Error("No lines matched");
      }

      // Verify target account exists in this org
      const toAcct = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.toAccountId), eq(accounts.orgId, currentOrgId())))
        .then((r: any[]) => r[0]);
      if (!toAcct) throw new Error("Target account not found");

      // Bulk update
      const updated = await tx
        .update(journalLines)
        .set({ accountId: input.toAccountId })
        .where(inArray(journalLines.id, targetIds))
        .returning({ id: journalLines.id });
      const linesUpdated = updated.length;

      // Audit entry (zero-effect: not real journal lines, just a record)
      const auditEntry = await tx
        .insert(journalEntries)
        .values({
          orgId: currentOrgId(),
          date: new Date().toISOString().slice(0, 10),
          memo: input.memo || `Reclassified ${linesUpdated} line(s) to ${toAcct.code} ${toAcct.name}`,
          reference: `RECLASS-${Date.now()}`,
          source: "reclassify",
        })
        .returning().then((r) => r[0]);

      return { linesUpdated, entryId: auditEntry.id, lineIds: targetIds };
    });
  }

  // ---------- Reports ----------
  // Compute account balances. Returns map accountId -> { debit, credit, balance(signed by normal side) }
  async accountBalances(asOfDate?: string, filter?: DimFilter): Promise<Map<number, { debit: number; credit: number; balance: number }>> {
    // Org-scope: filter by je.org_id. Note: even though this method is wrapped by listAccounts()
    // (which is also org-scoped), filtering at the SQL level is faster AND defends against the
    // case where journal_lines from other orgs accidentally reference our account IDs.
    const orgId = currentOrgId();
    const params: any[] = [orgId];
    const conds: string[] = [`je.org_id = $1`];
    if (asOfDate) { params.push(asOfDate); conds.push(`je.date <= $${params.length}`); }
    if (filter?.classId != null) { params.push(filter.classId); conds.push(`jl.class_id = $${params.length}`); }
    if (filter?.locationId != null) { params.push(filter.locationId); conds.push(`jl.location_id = $${params.length}`); }
    if (filter?.projectId != null) { params.push(filter.projectId); conds.push(`jl.project_id = $${params.length}`); }
    const q = `
      SELECT jl.account_id as "accountId",
             COALESCE(SUM(jl.debit), 0) as debit,
             COALESCE(SUM(jl.credit), 0) as credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${conds.join(" AND ")}
      GROUP BY jl.account_id
    `;
    const rows = (await pool.query(q, params)).rows as Array<{
      accountId: number;
      debit: number;
      credit: number;
    }>;
    const all = await this.listAccounts();
    const acctMap = new Map(all.map((a) => [a.id, a]));
    const result = new Map<number, { debit: number; credit: number; balance: number }>();
    for (const a of all) {
      result.set(a.id, { debit: 0, credit: 0, balance: 0 });
    }
    for (const r of rows) {
      const a = acctMap.get(r.accountId);
      if (!a) continue;
      const isDebitNormal = a.type === "asset" || a.type === "expense";
      const balance = isDebitNormal ? r.debit - r.credit : r.credit - r.debit;
      result.set(r.accountId, { debit: r.debit, credit: r.credit, balance });
    }
    return result;
  }

  // Trial Balance
  async trialBalance(asOfDate?: string) {
    const balances = await this.accountBalances(asOfDate);
    const all = await this.listAccounts();
    let totalDebit = 0;
    let totalCredit = 0;
    const rows = all.map((a) => {
      const b = balances.get(a.id) || { debit: 0, credit: 0, balance: 0 };
      const isDebitNormal = a.type === "asset" || a.type === "expense";
      const debitBal = isDebitNormal ? Math.max(b.balance, 0) : Math.max(-b.balance, 0);
      const creditBal = isDebitNormal ? Math.max(-b.balance, 0) : Math.max(b.balance, 0);
      totalDebit += debitBal;
      totalCredit += creditBal;
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debit: debitBal,
        credit: creditBal,
      };
    });
    return {
      asOfDate: asOfDate || new Date().toISOString().slice(0, 10),
      rows: rows.filter((r) => r.debit !== 0 || r.credit !== 0),
      totalDebit: totalDebit,
      totalCredit: totalCredit,
    };
  }

  // Profit & Loss for date range (optionally filtered by class/location).
  async profitAndLoss(fromDate: string, toDate: string, filter?: DimFilter) {
    const orgId = currentOrgId();
    // Dimension predicate lives INSIDE the je-match group so undimensioned
    // accounts still resolve to 0 (not dropped), and a null filter is a no-op.
    const params: any[] = [orgId, fromDate, toDate];
    let dimPred = "";
    if (filter?.classId != null) { params.push(filter.classId); dimPred += ` AND jl.class_id = $${params.length}`; }
    if (filter?.locationId != null) { params.push(filter.locationId); dimPred += ` AND jl.location_id = $${params.length}`; }
    if (filter?.projectId != null) { params.push(filter.projectId); dimPred += ` AND jl.project_id = $${params.length}`; }
    const q = `
      SELECT a.id as "accountId", a.code, a.name, a.type, a.subtype,
             COALESCE(SUM(jl.debit), 0) as debit,
             COALESCE(SUM(jl.credit), 0) as credit
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id
      WHERE a.type IN ('income','expense') AND a.org_id = $1
        AND (je.id IS NULL OR (je.org_id = $1 AND je.date BETWEEN $2 AND $3${dimPred}))
      GROUP BY a.id
      ORDER BY a.code
    `;
    const rows = (await pool.query(q, params)).rows as any[];
    const income = rows
      .filter((r) => r.type === "income")
      .map((r) => ({ ...r, amount: (r.credit - r.debit) }))
      .filter((r) => r.amount !== 0);
    const expenses = rows
      .filter((r) => r.type === "expense")
      .map((r) => ({ ...r, amount: (r.debit - r.credit) }))
      .filter((r) => r.amount !== 0);
    const totalIncome = income.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
    const netIncome = (totalIncome - totalExpenses);
    return { fromDate, toDate, income, expenses, totalIncome, totalExpenses, netIncome };
  }

  // Profit & Loss BY PROJECT (QBO "P&L by Job"): one income/expense/net rollup
  // per project over a date range, plus an "Unassigned" bucket for lines with no
  // project. Sums are exact integer cents; net = income − expenses per project.
  async projectProfitAndLoss(fromDate: string, toDate: string): Promise<{
    fromDate: string;
    toDate: string;
    rows: Array<{ projectId: number | null; name: string; income: number; expenses: number; net: number }>;
    totalIncome: number;
    totalExpenses: number;
    netIncome: number;
  }> {
    const orgId = currentOrgId();
    const raw = (await pool.query(
      `SELECT jl.project_id AS "projectId", a.type,
              COALESCE(SUM(jl.debit), 0)  AS debit,
              COALESCE(SUM(jl.credit), 0) AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a        ON a.id = jl.account_id
        WHERE je.org_id = $1 AND a.type IN ('income','expense')
          AND je.date BETWEEN $2 AND $3
        GROUP BY jl.project_id, a.type`,
      [orgId, fromDate, toDate],
    )).rows as Array<{ projectId: number | null; type: string; debit: number; credit: number }>;

    const projList = await this.listProjects();
    const nameById = new Map(projList.map((p) => [p.id, p.name]));
    const agg = new Map<number | null, { income: number; expenses: number }>();
    for (const r of raw) {
      const key = r.projectId ?? null;
      const cur = agg.get(key) ?? { income: 0, expenses: 0 };
      if (r.type === "income") cur.income += Number(r.credit) - Number(r.debit);
      else cur.expenses += Number(r.debit) - Number(r.credit);
      agg.set(key, cur);
    }
    const rows = [...agg.entries()]
      .map(([projectId, v]) => ({
        projectId,
        name: projectId === null ? "Unassigned" : (nameById.get(projectId) ?? `Project #${projectId}`),
        income: v.income,
        expenses: v.expenses,
        net: v.income - v.expenses,
      }))
      .filter((r) => r.income !== 0 || r.expenses !== 0)
      .sort((a, b) => b.net - a.net);
    const totalIncome = rows.reduce((s, r) => s + r.income, 0);
    const totalExpenses = rows.reduce((s, r) => s + r.expenses, 0);
    return { fromDate, toDate, rows, totalIncome, totalExpenses, netIncome: totalIncome - totalExpenses };
  }

  // Balance Sheet as of date (optionally filtered by class/location).
  async balanceSheet(asOfDate: string, filter?: DimFilter) {
    const balances = await this.accountBalances(asOfDate, filter);
    const all = await this.listAccounts();

    // Compute net income up to asOfDate (closes to retained earnings conceptually)
    const pl = await this.profitAndLoss("0000-01-01", asOfDate, filter);
    const netIncome = pl.netIncome;

    const buildSection = (type: string) =>
      all
        .filter((a) => a.type === type)
        .map((a) => {
          const b = balances.get(a.id) || { balance: 0 };
          return { accountId: a.id, code: a.code, name: a.name, balance: b.balance };
        })
        .filter((r) => r.balance !== 0);

    const assets = buildSection("asset");
    const liabilities = buildSection("liability");
    const equity = buildSection("equity");

    const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
    const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0);
    const equityFromAccounts = equity.reduce((s, r) => s + r.balance, 0);
    // Add current period net income to equity
    const totalEquity = (equityFromAccounts + netIncome);

    return {
      asOfDate,
      assets,
      liabilities,
      equity: [...equity, { accountId: -1, code: "—", name: "Net Income (current period)", balance: netIncome }],
      totalAssets,
      totalLiabilities,
      totalEquity,
      liabilitiesAndEquity: (totalLiabilities + totalEquity),
    };
  }

  // Dashboard summary metrics
  async dashboardStats() {
    const allInvoices = await db.select().from(invoices).where(eq(invoices.orgId, currentOrgId()));
    const allBills = await db.select().from(bills).where(eq(bills.orgId, currentOrgId()));
    const accountsList = await this.listAccounts();
    const balances = await this.accountBalances();

    const cashAccounts = accountsList.filter((a) => a.subtype === "bank");
    const cashOnHand = cashAccounts.reduce(
      (s, a) => s + (balances.get(a.id)?.balance || 0),
      0
    );

    const arOutstanding = allInvoices
      .filter((i) => i.status === "open")
      .reduce((s, i) => s + (i.total - i.amountPaid), 0);
    const apOutstanding = allBills
      .filter((b) => b.status === "open")
      .reduce((s, b) => s + (b.total - b.amountPaid), 0);

    const today = new Date().toISOString().slice(0, 10);
    const overdueInvoices = allInvoices.filter((i) => i.status === "open" && i.dueDate < today).length;
    const overdueBills = allBills.filter((b) => b.status === "open" && b.dueDate < today).length;

    // Revenue & expenses for current month
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const pl = await this.profitAndLoss(startOfMonth, today);

    return {
      cashOnHand: cashOnHand,
      arOutstanding: arOutstanding,
      apOutstanding: apOutstanding,
      overdueInvoices,
      overdueBills,
      revenueThisMonth: pl.totalIncome,
      expensesThisMonth: pl.totalExpenses,
      netIncomeThisMonth: pl.netIncome,
    };
  }

  // ============================================================================
  // GENERAL LEDGER (per-account drill-down with running balance)
  // ============================================================================
  async generalLedger(accountId: number, fromDate: string, toDate: string) {
    // Org-scoped lookup: IDs are a GLOBAL sequence, so accountId alone is
    // guessable across tenants — without this filter a user in Org A could
    // read Org B's entire ledger for any account id they enumerate.
    const acct = await db.select().from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    if (!acct) throw new Error("Account not found");
    const isDebitNormal = acct.type === "asset" || acct.type === "expense";

    // Opening balance: sum all activity strictly before fromDate (org-scoped)
    const op = (await pool.query(`
      SELECT COALESCE(SUM(jl.debit), 0) as debit, COALESCE(SUM(jl.credit), 0) as credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = $1 AND je.date < $2 AND je.org_id = $3
    `, [accountId, fromDate, currentOrgId()])).rows[0] as { debit: number; credit: number };
    const openingBalance = isDebitNormal ? op.debit - op.credit : op.credit - op.debit;

    // Activity in range (org-scoped)
    const txs = (await pool.query(`
      SELECT je.id as "entryId", je.date, je.memo, je.reference, je.source,
             jl.id as "lineId", jl.debit, jl.credit, jl.description
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = $1 AND je.date BETWEEN $2 AND $3 AND je.org_id = $4
      ORDER BY je.date ASC, je.id ASC, jl.id ASC
    `, [accountId, fromDate, toDate, currentOrgId()])).rows as Array<{
      entryId: number;
      date: string;
      memo: string | null;
      reference: string | null;
      source: string | null;
      lineId: number;
      debit: number;
      credit: number;
      description: string | null;
    }>;

    let running = openingBalance;
    const lines = txs.map((t) => {
      const change = isDebitNormal ? t.debit - t.credit : t.credit - t.debit;
      running = (running + change);
      return {
        ...t,
        balance: running,
      };
    });

    const totalDebit = txs.reduce((s, t) => s + t.debit, 0);
    const totalCredit = txs.reduce((s, t) => s + t.credit, 0);
    const netChange = (isDebitNormal ? totalDebit - totalCredit : totalCredit - totalDebit);

    return {
      account: acct,
      fromDate,
      toDate,
      openingBalance: openingBalance,
      lines,
      totalDebit,
      totalCredit,
      netChange,
      closingBalance: running,
    };
  }

  // ============================================================================
  // A/R AGING — outstanding invoices grouped by age bucket per customer
  // ============================================================================
  async arAging(asOfDate?: string) {
    const today = asOfDate || new Date().toISOString().slice(0, 10);
    const allInvoices = await db.select().from(invoices).where(eq(invoices.orgId, currentOrgId()));
    // Direct query, NOT the paginated listCustomers() — aging reports need every customer.
    const allCustomers = await db.select().from(customers).where(eq(customers.orgId, currentOrgId()));
    const custMap = new Map(allCustomers.map((c) => [c.id, c]));

    const buckets = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
    type Bucket = typeof buckets[number];
    const bucketLabel: Record<Bucket, string> = {
      current: "Current",
      d1_30: "1-30",
      d31_60: "31-60",
      d61_90: "61-90",
      d90_plus: "90+",
    };

    function ageOf(dueDate: string): Bucket {
      const due = new Date(dueDate + "T00:00:00Z");
      const ref = new Date(today + "T00:00:00Z");
      const diff = Math.floor((ref.getTime() - due.getTime()) / 86400000);
      if (diff <= 0) return "current";
      if (diff <= 30) return "d1_30";
      if (diff <= 60) return "d31_60";
      if (diff <= 90) return "d61_90";
      return "d90_plus";
    }

    type Row = {
      customerId: number;
      customerName: string;
      current: number;
      d1_30: number;
      d31_60: number;
      d61_90: number;
      d90_plus: number;
      total: number;
      invoices: Array<{
        id: number;
        number: string;
        date: string;
        dueDate: string;
        balance: number;
        bucket: Bucket;
      }>;
    };
    const rowMap = new Map<number, Row>();

    for (const inv of allInvoices) {
      if (inv.status === "void") continue;
      const balance = (inv.total - inv.amountPaid);
      if (balance === 0) continue;
      const bucket = ageOf(inv.dueDate);
      const cust = custMap.get(inv.customerId);
      if (!cust) continue;
      let row = rowMap.get(cust.id);
      if (!row) {
        row = {
          customerId: cust.id,
          customerName: cust.name,
          current: 0,
          d1_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90_plus: 0,
          total: 0,
          invoices: [],
        };
        rowMap.set(cust.id, row);
      }
      row[bucket] = (row[bucket] + balance);
      row.total = (row.total + balance);
      row.invoices.push({
        id: inv.id,
        number: inv.number,
        date: inv.date,
        dueDate: inv.dueDate,
        balance,
        bucket,
      });
    }

    // Unapplied credit notes appear as NEGATIVE balances per customer. The
    // credit note already credited A/R in the GL at issue, so including it here
    // (as of its issue date) keeps the aging total reconciled with the A/R
    // GL balance. Credit notes have no due date — they sit in "current".
    const openCredits = await db
      .select()
      .from(creditNotes)
      .where(and(
        eq(creditNotes.orgId, currentOrgId()),
        eq(creditNotes.status, "issued"),
        gt(creditNotes.remainingCredit, 0),
        lte(creditNotes.date, today),
      ))
      ;
    for (const cn of openCredits) {
      const cust = custMap.get(cn.customerId);
      if (!cust) continue;
      let row = rowMap.get(cust.id);
      if (!row) {
        row = {
          customerId: cust.id,
          customerName: cust.name,
          current: 0,
          d1_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90_plus: 0,
          total: 0,
          invoices: [],
        };
        rowMap.set(cust.id, row);
      }
      const credit = -cn.remainingCredit;
      row.current = (row.current + credit);
      row.total = (row.total + credit);
      row.invoices.push({
        id: cn.id,
        number: cn.number, // CN-xxxx — distinguishes it from invoices in the row detail
        date: cn.date,
        dueDate: cn.date,
        balance: credit,
        bucket: "current",
      });
    }

    const rows = Array.from(rowMap.values()).sort((a, b) => b.total - a.total);
    const totals = {
      current: rows.reduce((s, r) => s + r.current, 0),
      d1_30: rows.reduce((s, r) => s + r.d1_30, 0),
      d31_60: rows.reduce((s, r) => s + r.d31_60, 0),
      d61_90: rows.reduce((s, r) => s + r.d61_90, 0),
      d90_plus: rows.reduce((s, r) => s + r.d90_plus, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    };

    // Cross-check against the A/R GL balance. If a manual JE was posted directly to
    // Accounts Receivable (not through createInvoice/payInvoice), the invoice-based
    // aging will diverge from the GL. Surface that as a warning so users know.
    const arAcct = await db.select().from(accounts).where(and(eq(accounts.code, "1100"), eq(accounts.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    let glBalance = 0;
    let warning: string | undefined;
    if (arAcct) {
      const bals = await this.accountBalances(today);
      glBalance = (bals.get(arAcct.id)?.balance || 0);
      const diff = (totals.total - glBalance);
      if (diff !== 0) {
        warning = `Aging total (${formatMoney(totals.total)}) does not match A/R GL balance (${formatMoney(glBalance)}). Difference: ${formatMoney(diff)}. This usually means manual journal entries were posted directly to A/R bypassing the invoice workflow.`;
      }
    }
    return { asOfDate: today, bucketLabel, rows, totals, glBalance, warning };
  }

  // ============================================================================
  // A/P AGING — outstanding bills grouped by age bucket per vendor
  // ============================================================================
  async apAging(asOfDate?: string) {
    const today = asOfDate || new Date().toISOString().slice(0, 10);
    const allBills = await db.select().from(bills).where(eq(bills.orgId, currentOrgId()));
    // Direct query, NOT the paginated listVendors() — aging reports need every vendor.
    const allVendors = await db.select().from(vendors).where(eq(vendors.orgId, currentOrgId()));
    const venMap = new Map(allVendors.map((v) => [v.id, v]));

    const buckets = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
    type Bucket = typeof buckets[number];
    const bucketLabel: Record<Bucket, string> = {
      current: "Current",
      d1_30: "1-30",
      d31_60: "31-60",
      d61_90: "61-90",
      d90_plus: "90+",
    };

    function ageOf(dueDate: string): Bucket {
      const due = new Date(dueDate + "T00:00:00Z");
      const ref = new Date(today + "T00:00:00Z");
      const diff = Math.floor((ref.getTime() - due.getTime()) / 86400000);
      if (diff <= 0) return "current";
      if (diff <= 30) return "d1_30";
      if (diff <= 60) return "d31_60";
      if (diff <= 90) return "d61_90";
      return "d90_plus";
    }

    type Row = {
      vendorId: number;
      vendorName: string;
      current: number;
      d1_30: number;
      d31_60: number;
      d61_90: number;
      d90_plus: number;
      total: number;
      bills: Array<{
        id: number;
        number: string;
        date: string;
        dueDate: string;
        balance: number;
        bucket: Bucket;
      }>;
    };
    const rowMap = new Map<number, Row>();

    for (const b of allBills) {
      if (b.status === "void") continue;
      const balance = (b.total - b.amountPaid);
      if (balance === 0) continue;
      const bucket = ageOf(b.dueDate);
      const ven = venMap.get(b.vendorId);
      if (!ven) continue;
      let row = rowMap.get(ven.id);
      if (!row) {
        row = {
          vendorId: ven.id,
          vendorName: ven.name,
          current: 0,
          d1_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90_plus: 0,
          total: 0,
          bills: [],
        };
        rowMap.set(ven.id, row);
      }
      row[bucket] = (row[bucket] + balance);
      row.total = (row.total + balance);
      row.bills.push({
        id: b.id,
        number: b.number,
        date: b.date,
        dueDate: b.dueDate,
        balance,
        bucket,
      });
    }

    // Unapplied debit notes appear as NEGATIVE balances per vendor — the note
    // already debited A/P at creation, so the aging total stays reconciled
    // with the A/P GL balance. No due date — they sit in "current".
    const openDebits = await db
      .select()
      .from(debitNotes)
      .where(and(
        eq(debitNotes.orgId, currentOrgId()),
        eq(debitNotes.status, "sent"),
        gt(debitNotes.remainingDebit, 0),
        lte(debitNotes.date, today),
      ))
      ;
    for (const dn of openDebits) {
      const ven = venMap.get(dn.vendorId);
      if (!ven) continue;
      let row = rowMap.get(ven.id);
      if (!row) {
        row = {
          vendorId: ven.id,
          vendorName: ven.name,
          current: 0,
          d1_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90_plus: 0,
          total: 0,
          bills: [],
        };
        rowMap.set(ven.id, row);
      }
      const debit = -dn.remainingDebit;
      row.current = (row.current + debit);
      row.total = (row.total + debit);
      row.bills.push({
        id: dn.id,
        number: dn.number, // DN-xxxx
        date: dn.date,
        dueDate: dn.date,
        balance: debit,
        bucket: "current",
      });
    }

    const rows = Array.from(rowMap.values()).sort((a, b) => b.total - a.total);
    const totals = {
      current: rows.reduce((s, r) => s + r.current, 0),
      d1_30: rows.reduce((s, r) => s + r.d1_30, 0),
      d31_60: rows.reduce((s, r) => s + r.d31_60, 0),
      d61_90: rows.reduce((s, r) => s + r.d61_90, 0),
      d90_plus: rows.reduce((s, r) => s + r.d90_plus, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    };

    // Cross-check against the A/P GL balance — same idea as arAging.
    const apAcct = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, "2000"), eq(accounts.orgId, currentOrgId())))
      .then((r: any[]) => r[0]);
    let glBalance = 0;
    let warning: string | undefined;
    if (apAcct) {
      const bals = await this.accountBalances(today);
      glBalance = (bals.get(apAcct.id)?.balance || 0);
      const diff = (totals.total - glBalance);
      if (diff !== 0) {
        warning = `Aging total (${formatMoney(totals.total)}) does not match A/P GL balance (${formatMoney(glBalance)}). Difference: ${formatMoney(diff)}. This usually means manual journal entries were posted directly to A/P bypassing the bill workflow.`;
      }
    }
    return { asOfDate: today, bucketLabel, rows, totals, glBalance, warning };
  }

  // ============================================================================
  // CASH FLOW STATEMENT (indirect-method-lite)
  // Operating: Net Income + change in non-cash working capital (A/R, A/P, Inventory)
  // Investing: change in fixed-asset accounts (subtype 'fixed_asset')
  // Financing: change in equity & long-term liabilities (Owner's Equity, etc.)
  // ============================================================================
  /**
   * Cash Flow Statement (Indirect Method)
   *
   * Mathematical foundation: from the accounting identity A = L + E, taking the period delta
   * and isolating cash gives:
   *     ΔCash = ΔLiabilities + ΔEquity + NetIncomeForPeriod − ΔOtherAssets
   * (where NetIncomeForPeriod stands in for the income/expense account balance changes,
   * which are equity-on-the-way-to-RE until a closing entry is posted.)
   *
   * The cash flow statement is just a categorized restatement of the right-hand side.
   * For a balanced ledger (which double-entry guarantees), the reconciliation gap MUST be 0.
   *
   * Classification rules (every non-cash, non-P&L account belongs to exactly ONE bucket):
   *   • Operating  — current assets, current liabilities, plus a synthetic "Depreciation &
   *                  Amortization" add-back from accumulated-depreciation contra-asset deltas.
   *   • Investing  — long-term assets (subtype 'fixed_asset' or 'intangible_asset').
   *   • Financing  — long-term liabilities + ALL equity accounts (including Retained Earnings).
   *
   * Bug fixes vs prior version:
   *   #1 Intangibles now included in Investing (previously misclassified as Operating).
   *   #2 Retained Earnings now included in Financing (previously excluded with `code !== '3100'`,
   *      which broke reconciliation whenever a closing entry was posted inside the period).
   *      The exclusion was based on a misunderstanding of the indirect-method identity:
   *      RE-balance only changes via closing JEs (a discrete past-period transfer), while
   *      current-period earnings live in income/expense accounts and are captured by NetIncome.
   *      The two are independent — both belong in the cash flow statement.
   *   #3 Explicit Depreciation & Amortization add-back line in Operating.
   *   #4 Robust handling of NULL/missing subtype — falls back to "current asset" / "current
   *      liability" classification with a warning in the response so the UI can flag the
   *      misconfiguration. The schema was also tightened to require subtype on new accounts.
   */
  async cashFlowStatement(fromDate: string, toDate: string) {
    const all = await this.listAccounts();
    const beforeFrom = (() => {
      const d = new Date(fromDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const startBalances = await this.accountBalances(beforeFrom);
    const endBalances = await this.accountBalances(toDate);

    const change = (acctId: number) => {
      const s = startBalances.get(acctId)?.balance || 0;
      const e = endBalances.get(acctId)?.balance || 0;
      return (e - s);
    };

    const pl = await this.profitAndLoss(fromDate, toDate);
    const netIncome = pl.netIncome;

    // Track unclassified accounts for diagnostic warnings
    const warnings: string[] = [];

    // Helper: subtype tests with NULL-safe behavior
    const isLongTermAsset = (a: typeof all[number]) =>
      a.type === "asset" && (a.subtype === "fixed_asset" || a.subtype === "intangible_asset");
    const isAccumDepreciation = (a: typeof all[number]) =>
      a.type === "asset" &&
      (a.subtype === "accumulated_depreciation" ||
        a.subtype === "accumulated_amortization" ||
        /^accumulated\b.*(depreciation|amortization)/i.test(a.name));
    const isLongTermLiability = (a: typeof all[number]) =>
      a.type === "liability" && a.subtype === "long_term_liability";
    const isBank = (a: typeof all[number]) => a.subtype === "bank";

    // ---------- OPERATING ACTIVITIES ----------
    const operatingItems: Array<{ label: string; amount: number }> = [
      { label: "Net Income", amount: netIncome },
    ];

    // Fix #3: Depreciation & Amortization add-back.
    // Accumulated depreciation is a contra-asset. As depreciation is recorded, its balance becomes
    // more negative (Cr Accum Dep). The period's depreciation expense equals the negative of the
    // change in accumulated-depreciation balance. We add this back to NI as a non-cash adjustment.
    let depreciationAddback = 0;
    for (const a of all.filter(isAccumDepreciation)) {
      const ch = change(a.id);
      if (ch === 0) continue;
      // accountBalances signs assets as (debit - credit), so accumulated dep typically has a negative balance.
      // A more negative balance (ch < 0) means MORE depreciation was recorded → add back |ch|.
      depreciationAddback += -ch;
    }
    if (depreciationAddback !== 0) {
      operatingItems.push({ label: "Depreciation & Amortization", amount: depreciationAddback });
    }

    // Working capital changes — current assets and current liabilities
    for (const a of all) {
      const ch = change(a.id);
      if (ch === 0) continue;
      if (isBank(a)) continue;                        // cash itself
      if (a.type === "income" || a.type === "expense") continue;  // already in NI
      if (isLongTermAsset(a)) continue;               // → Investing
      if (isAccumDepreciation(a)) continue;           // already handled as add-back
      if (isLongTermLiability(a)) continue;           // → Financing
      if (a.type === "equity") continue;              // → Financing

      if (a.type === "asset") {
        // Current asset (default for asset without long-term subtype)
        if (a.subtype !== "current_asset" && a.subtype !== null && a.subtype !== undefined && a.subtype !== "") {
          // Unknown subtype: classify as current but warn
          warnings.push(`Account "${a.name}" (${a.code}) has unrecognized subtype "${a.subtype}" — treated as current asset.`);
        }
        operatingItems.push({ label: `Change in ${a.name}`, amount: -ch });
      } else if (a.type === "liability") {
        if (
          a.subtype !== "current_liability" &&
          a.subtype !== "credit_card" &&
          a.subtype !== null && a.subtype !== undefined && a.subtype !== ""
        ) {
          warnings.push(`Account "${a.name}" (${a.code}) has unrecognized subtype "${a.subtype}" — treated as current liability.`);
        }
        operatingItems.push({ label: `Change in ${a.name}`, amount: ch });
      }
    }
    const operatingTotal = operatingItems.reduce((s, i) => s + i.amount, 0);

    // ---------- INVESTING ACTIVITIES ----------
    const investingItems: Array<{ label: string; amount: number }> = [];
    for (const a of all.filter(isLongTermAsset)) {
      const ch = change(a.id);
      if (ch === 0) continue;
      const verb = a.subtype === "intangible_asset" ? "Investment in" : "Purchase/sale of";
      investingItems.push({ label: `${verb} ${a.name}`, amount: -ch });
    }
    const investingTotal = investingItems.reduce((s, i) => s + i.amount, 0);

    // ---------- FINANCING ACTIVITIES ----------
    // Fix #2: Include ALL equity accounts (including Retained Earnings) without any offset.
    //
    // The previous code excluded code='3100' under the false belief that "Net Income captures it."
    // That's incorrect. The accounting identity is:
    //   ΔCash = ΔLiabilities + ΔEquity + NetIncomeForPeriod − ΔOtherAssets
    // where ΔEquity is the change in equity-account BALANCES (which only includes RE movement
    // from closing entries, not current-period earnings — those still sit in income/expense accounts
    // and are captured by NetIncomeForPeriod via profitAndLoss).
    //
    // When a closing entry fires inside the period, profitAndLoss correctly nets the closing-JE's
    // debit to Income against current-period sales credits, giving the right NI for the period.
    // RE's balance change (+prior_year_NI) shows up in Financing as the actual transfer it represents.
    // The math works out — no manual offsetting required.
    const financingItems: Array<{ label: string; amount: number }> = [];
    for (const a of all.filter((x) => x.type === "equity")) {
      const ch = change(a.id);
      if (ch === 0) continue;
      financingItems.push({ label: `Change in ${a.name}`, amount: ch });
    }
    for (const a of all.filter(isLongTermLiability)) {
      const ch = change(a.id);
      if (ch === 0) continue;
      financingItems.push({ label: `Change in ${a.name}`, amount: ch });
    }
    const financingTotal = financingItems.reduce((s, i) => s + i.amount, 0);

    const netCashChange = (operatingTotal + investingTotal + financingTotal);

    // ---------- DETECT YEAR-END CLOSE INSIDE PERIOD (UX warning) ----------
    // If a closing entry was posted inside the cash flow period, the math is still correct
    // (the engine reconciles), but the "Net Income" line shown to the user mixes current-period
    // earnings with a debit from the closing entry. Flag this so the UI can suggest the user
    // run separate reports for the two sub-periods.
    const closingInPeriod = (await pool.query(`
      SELECT COUNT(*) AS c FROM journal_entries
      WHERE date >= $1 AND date <= $2
        AND (memo LIKE 'Year-end close%' OR reference LIKE 'YE-%')
    `, [fromDate, toDate])).rows[0] as { c: number } | undefined;
    if (closingInPeriod && closingInPeriod.c > 0) {
      warnings.push(
        "A year-end-close entry was posted inside this date range. The Net Income line above mixes earnings from before and after the close. " +
        "For clearer reporting, consider running two separate cash flow reports: one ending on the fiscal year-end, one starting the day after."
      );
    }


    const cashAccts = all.filter(isBank);
    const cashStart = cashAccts.reduce((s, a) => s + (startBalances.get(a.id)?.balance || 0), 0);
    const cashEnd = cashAccts.reduce((s, a) => s + (endBalances.get(a.id)?.balance || 0), 0);
    const reconciliationGap = (cashEnd - cashStart - netCashChange);

    return {
      fromDate,
      toDate,
      operating: { items: operatingItems, total: operatingTotal },
      investing: { items: investingItems, total: investingTotal },
      financing: { items: financingItems, total: financingTotal },
      netCashChange,
      cashStart,
      cashEnd,
      reconciliationGap,
      reconciles: reconciliationGap === 0, // exact — integer cents
      warnings,
    };
  }

  // ============================================================================
  // CUSTOMER STATEMENT — invoices + payments for one customer in a date range
  // ============================================================================
  async customerStatement(customerId: number, fromDate: string, toDate: string) {
    const cust = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!cust) throw new Error("Customer not found");

    // Opening balance: A/R activity for this customer strictly before fromDate.
    // We approximate by summing invoices.total - payments before from.
    const allInv = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.orgId, currentOrgId())));

    let openingBalance = 0;
    const activity: Array<{
      date: string;
      type: "invoice" | "payment";
      reference: string;
      description: string;
      charge: number;
      payment: number;
      balance: number;
    }> = [];

    // Payment events: journal entries whose reference matches one of this customer's invoice numbers.
    // We require a credit on A/R (code 1100) — that's how invoice payments hit the GL — to filter out
    // unrelated entries that happen to share the same reference. Source values vary ('payment' for the
    // direct payInvoice flow, 'invoice_payment' for bank-match flow), so we look at GL impact, not source.
    const invByNumber = new Map(allInv.map((i) => [i.number, i]));
    let payments: Array<{ date: string; reference: string | null; memo: string | null; debit: number }> = [];
    if (invByNumber.size > 0) {
      // PostgreSQL: pass the number list as an array (= ANY($1)); HAVING cannot
      // reference SELECT aliases, so the aggregate expression is repeated.
      const rows = (await pool.query(`
        SELECT je.date, je.reference, je.memo,
               COALESCE(SUM(CASE WHEN ar.id = jl.account_id THEN jl.credit ELSE 0 END), 0) AS ar_credit,
               COALESCE(SUM(CASE WHEN bank.subtype = 'bank' AND jl.account_id = bank.id THEN jl.debit ELSE 0 END), 0) AS bank_debit
        FROM journal_entries je
        INNER JOIN journal_lines jl ON jl.entry_id = je.id
        INNER JOIN accounts ar ON ar.code = '1100' AND ar.org_id = $2
        LEFT JOIN accounts bank ON bank.id = jl.account_id AND bank.subtype = 'bank'
        WHERE je.reference = ANY($1)
          AND je.source IN ('payment', 'invoice_payment')
          AND je.org_id = $2
        GROUP BY je.id, je.date, je.reference, je.memo
        HAVING COALESCE(SUM(CASE WHEN ar.id = jl.account_id THEN jl.credit ELSE 0 END), 0) > 0
      `, [Array.from(invByNumber.keys()), currentOrgId()])).rows as Array<{ date: string; reference: string | null; memo: string | null; ar_credit: number; bank_debit: number }>;
      payments = rows.map((r) => ({ date: r.date, reference: r.reference, memo: r.memo, debit: r.ar_credit }));
    }

    type Evt = { date: string; type: "invoice" | "payment"; reference: string; description: string; charge: number; payment: number };
    const events: Evt[] = [];
    for (const inv of allInv) {
      events.push({
        date: inv.date,
        type: "invoice",
        reference: inv.number,
        description: `Invoice ${inv.number}`,
        charge: inv.total,
        payment: 0,
      });
    }
    for (const p of payments) {
      if (!p.reference) continue;
      const inv = invByNumber.get(p.reference);
      if (!inv) continue;
      events.push({
        date: p.date,
        type: "payment",
        reference: p.reference,
        description: `Payment: ${p.memo || p.reference}`,
        charge: 0,
        payment: p.debit,
      });
    }

    events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    let running = 0;
    for (const e of events) {
      running = (running + e.charge - e.payment);
      if (e.date < fromDate) {
        openingBalance = running;
        continue;
      }
      if (e.date > toDate) break;
      activity.push({ ...e, balance: running });
    }

    const totalCharges = activity.reduce((s, a) => s + a.charge, 0);
    const totalPayments = activity.reduce((s, a) => s + a.payment, 0);
    const closingBalance = running;

    return {
      customer: cust,
      fromDate,
      toDate,
      openingBalance,
      activity,
      totalCharges,
      totalPayments,
      closingBalance,
    };
  }

  // ============================================================================
  // VENDOR STATEMENT — bills + payments for one vendor in a date range
  // ============================================================================
  async vendorStatement(vendorId: number, fromDate: string, toDate: string) {
    const ven = await db.select().from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.orgId, currentOrgId()))).then((r: any[]) => r[0]);
    if (!ven) throw new Error("Vendor not found");

    const allBills = await db
      .select()
      .from(bills)
      .where(and(eq(bills.vendorId, vendorId), eq(bills.orgId, currentOrgId())));

    // Payment events: journal entries whose reference matches one of this vendor's bill numbers AND
    // that have a debit to A/P (code 2000). Source can be 'payment' or 'bill_payment'.
    const billByNumber = new Map(allBills.map((b) => [b.number, b]));
    let payments: Array<{ date: string; reference: string | null; memo: string | null; credit: number }> = [];
    if (billByNumber.size > 0) {
      const rows = (await pool.query(`
        SELECT je.date, je.reference, je.memo,
               COALESCE(SUM(CASE WHEN ap.id = jl.account_id THEN jl.debit ELSE 0 END), 0) AS ap_debit
        FROM journal_entries je
        INNER JOIN journal_lines jl ON jl.entry_id = je.id
        INNER JOIN accounts ap ON ap.code = '2000' AND ap.org_id = $2
        WHERE je.reference = ANY($1)
          AND je.source IN ('payment', 'bill_payment')
          AND je.org_id = $2
        GROUP BY je.id, je.date, je.reference, je.memo
        HAVING COALESCE(SUM(CASE WHEN ap.id = jl.account_id THEN jl.debit ELSE 0 END), 0) > 0
      `, [Array.from(billByNumber.keys()), currentOrgId()])).rows as Array<{ date: string; reference: string | null; memo: string | null; ap_debit: number }>;
      payments = rows.map((r) => ({ date: r.date, reference: r.reference, memo: r.memo, credit: r.ap_debit }));
    }

    type Evt = { date: string; type: "bill" | "payment"; reference: string; description: string; charge: number; payment: number };
    const events: Evt[] = [];
    for (const b of allBills) {
      events.push({
        date: b.date,
        type: "bill",
        reference: b.number,
        description: `Bill ${b.number}`,
        charge: b.total,
        payment: 0,
      });
    }
    for (const p of payments) {
      if (!p.reference) continue;
      const bill = billByNumber.get(p.reference);
      if (!bill) continue;
      events.push({
        date: p.date,
        type: "payment",
        reference: p.reference,
        description: `Payment: ${p.memo || p.reference}`,
        charge: 0,
        payment: p.credit,
      });
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    let running = 0;
    let openingBalance = 0;
    const activity: Array<{ date: string; type: "bill" | "payment"; reference: string; description: string; charge: number; payment: number; balance: number }> = [];
    for (const e of events) {
      running = (running + e.charge - e.payment);
      if (e.date < fromDate) {
        openingBalance = running;
        continue;
      }
      if (e.date > toDate) break;
      activity.push({ ...e, balance: running });
    }

    const totalCharges = activity.reduce((s, a) => s + a.charge, 0);
    const totalPayments = activity.reduce((s, a) => s + a.payment, 0);
    const closingBalance = running;

    return {
      vendor: ven,
      fromDate,
      toDate,
      openingBalance,
      activity,
      totalCharges,
      totalPayments,
      closingBalance,
    };
  }

  // ============================================================================
  // ATTACHMENTS
  // ============================================================================
  // Entity ownership is verified BEFORE any blob write: entity_id alone is
  // guessable (global sequences), so the entity row must exist under
  // currentOrgId() — the same rule as every other lookup in this file.
  // Entity types that can carry attachments. Every branch validates the entity
  // exists IN THE CURRENT ORG, so attachments inherit the same org-scoped access
  // control as everything else — a receipt can never be attached to (or, via the
  // org-scoped get/list/delete below, read from) another tenant's record.
  //   • payment → the journal entry that recorded an invoice/bill payment
  //     (source 'payment'/'bill_payment'), so receipts attach to the payment
  //     itself rather than only the generic journal entry.
  async assertAttachmentEntity(entityType: string, entityId: number): Promise<void> {
    const org = currentOrgId();
    let sql: string;
    switch (entityType) {
      case "invoice": sql = `SELECT 1 FROM invoices WHERE id = $1 AND org_id = $2`; break;
      case "bill": sql = `SELECT 1 FROM bills WHERE id = $1 AND org_id = $2`; break;
      case "bank_transaction": sql = `SELECT 1 FROM bank_transactions WHERE id = $1 AND org_id = $2`; break;
      case "journal_entry": sql = `SELECT 1 FROM journal_entries WHERE id = $1 AND org_id = $2`; break;
      case "payment": sql = `SELECT 1 FROM journal_entries WHERE id = $1 AND org_id = $2 AND source IN ('payment','bill_payment')`; break;
      default: throw new Error(`Unsupported entity type "${entityType}"`);
    }
    const r = (await pool.query(sql, [entityId, org])).rows[0];
    if (!r) throw new Error(`${entityType.replace(/_/g, " ")} not found`);
  }

  async createAttachment(input: {
    entityType: string; entityId: number; filename: string; mimeType: string; sizeBytes: number; storageKey: string;
  }): Promise<{ id: number }> {
    const r = (await pool.query(
      `INSERT INTO attachments (org_id, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [currentOrgId(), input.entityType, input.entityId, input.filename, input.mimeType, input.sizeBytes, input.storageKey, currentUserId() ?? null]
    )).rows[0];
    await this.audit("upload", "attachment", Number(r.id), `Attached "${input.filename}" (${input.mimeType}, ${input.sizeBytes} bytes) to ${input.entityType} #${input.entityId}`);
    return { id: Number(r.id) };
  }

  async getAttachment(id: number): Promise<{ id: number; entityType: string; entityId: number; filename: string; mimeType: string; sizeBytes: number; storageKey: string } | undefined> {
    const r = (await pool.query(
      `SELECT id, entity_type AS "entityType", entity_id AS "entityId", filename, mime_type AS "mimeType",
              size_bytes AS "sizeBytes", storage_key AS "storageKey"
         FROM attachments WHERE id = $1 AND org_id = $2`,
      [id, currentOrgId()]
    )).rows[0];
    return r as any || undefined;
  }

  async listAttachments(entityType: string, entityId: number): Promise<any[]> {
    return (await pool.query(
      `SELECT id, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes", created_at AS "createdAt"
         FROM attachments WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY id DESC`,
      [currentOrgId(), entityType, entityId]
    )).rows;
  }

  async deleteAttachment(id: number): Promise<{ storageKey: string }> {
    const r = (await pool.query(
      `DELETE FROM attachments WHERE id = $1 AND org_id = $2 RETURNING storage_key AS "storageKey", filename`,
      [id, currentOrgId()]
    )).rows[0];
    if (!r) throw new Error("Attachment not found");
    await this.audit("delete", "attachment", id, `Deleted attachment "${r.filename}"`);
    return { storageKey: r.storageKey };
  }

  // ============================================================================
  // REPORT PACK (Phase 3): sales by customer, expenses by vendor, monthly P&L,
  // budgets + budget-vs-actual. All figures BASE-currency integer cents.
  // DATE GROUPING NOTE: dates are TEXT "YYYY-MM-DD" throughout the schema, so
  // substr(date, 1, 7) = "YYYY-MM" is an EXACT calendar-month grouping — no
  // timezone drift, no date_trunc needed.
  // ============================================================================

  async salesByCustomer(fromDate: string, toDate: string) {
    // invoiced = non-void invoice totals; credited = issued/applied credit
    // notes; paid = amount_paid on those invoices; balance = net - paid.
    const rows = (await pool.query(`
      SELECT c.id AS "customerId", c.name AS "customerName",
             COALESCE(inv.invoiced, 0)::bigint AS invoiced,
             COALESCE(cn.credited, 0)::bigint AS credited,
             (COALESCE(inv.invoiced, 0) - COALESCE(cn.credited, 0))::bigint AS net,
             COALESCE(inv.paid, 0)::bigint AS paid,
             (COALESCE(inv.invoiced, 0) - COALESCE(cn.credited, 0) - COALESCE(inv.paid, 0))::bigint AS balance
        FROM customers c
        LEFT JOIN (
          SELECT customer_id, SUM(total) AS invoiced, SUM(amount_paid) AS paid
            FROM invoices
           WHERE org_id = $1 AND status != 'void' AND date >= $2 AND date <= $3
           GROUP BY customer_id
        ) inv ON inv.customer_id = c.id
        LEFT JOIN (
          SELECT customer_id, SUM(total) AS credited
            FROM credit_notes
           WHERE org_id = $1 AND status NOT IN ('void','draft') AND date >= $2 AND date <= $3
           GROUP BY customer_id
        ) cn ON cn.customer_id = c.id
       WHERE c.org_id = $1
         AND (inv.invoiced IS NOT NULL OR cn.credited IS NOT NULL)
       ORDER BY net DESC, c.name
    `, [currentOrgId(), fromDate, toDate])).rows;
    return rows;
  }

  async expensesByVendor(fromDate: string, toDate: string) {
    const rows = (await pool.query(`
      SELECT v.id AS "vendorId", v.name AS "vendorName",
             COALESCE(b.billed, 0)::bigint AS billed,
             COALESCE(dn.debited, 0)::bigint AS debited,
             (COALESCE(b.billed, 0) - COALESCE(dn.debited, 0))::bigint AS net,
             COALESCE(b.paid, 0)::bigint AS paid,
             (COALESCE(b.billed, 0) - COALESCE(dn.debited, 0) - COALESCE(b.paid, 0))::bigint AS balance
        FROM vendors v
        LEFT JOIN (
          SELECT vendor_id, SUM(total) AS billed, SUM(amount_paid) AS paid
            FROM bills
           WHERE org_id = $1 AND status != 'void' AND date >= $2 AND date <= $3
           GROUP BY vendor_id
        ) b ON b.vendor_id = v.id
        LEFT JOIN (
          SELECT vendor_id, SUM(total) AS debited
            FROM debit_notes
           WHERE org_id = $1 AND status NOT IN ('void','draft') AND date >= $2 AND date <= $3
           GROUP BY vendor_id
        ) dn ON dn.vendor_id = v.id
       WHERE v.org_id = $1
         AND (b.billed IS NOT NULL OR dn.debited IS NOT NULL)
       ORDER BY net DESC, v.name
    `, [currentOrgId(), fromDate, toDate])).rows;
    return rows;
  }

  async profitLossMonthly(fromDate: string, toDate: string) {
    // One SQL pass: month bucket via substr(date,1,7) (exact — TEXT dates),
    // income sign = credit-normal, expense = debit-normal.
    const rows = (await pool.query(`
      SELECT substr(je.date, 1, 7) AS month,
             a.id AS "accountId", a.code, a.name, a.type,
             SUM(CASE WHEN a.type = 'income' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END)::bigint AS amount
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE je.org_id = $1 AND a.org_id = $1
         AND a.type IN ('income', 'expense')
         AND je.date >= $2 AND je.date <= $3
       GROUP BY substr(je.date, 1, 7), a.id, a.code, a.name, a.type
       ORDER BY a.code, month
    `, [currentOrgId(), fromDate, toDate])).rows as Array<{ month: string; accountId: number; code: string; name: string; type: string; amount: number }>;

    // Pivot: one column per calendar month present in the range.
    const months = Array.from(new Set(rows.map((r) => r.month))).sort();
    const byAccount = new Map<number, { accountId: number; code: string; name: string; type: string; byMonth: Record<string, number>; total: number }>();
    for (const r of rows) {
      let acc = byAccount.get(r.accountId);
      if (!acc) {
        acc = { accountId: r.accountId, code: r.code, name: r.name, type: r.type, byMonth: {}, total: 0 };
        byAccount.set(r.accountId, acc);
      }
      acc.byMonth[r.month] = (acc.byMonth[r.month] ?? 0) + Number(r.amount);
      acc.total += Number(r.amount);
    }
    const accounts = Array.from(byAccount.values());
    const netByMonth: Record<string, number> = {};
    for (const m of months) {
      netByMonth[m] = accounts.reduce((s, a) => s + (a.type === "income" ? (a.byMonth[m] ?? 0) : -(a.byMonth[m] ?? 0)), 0);
    }
    return { months, accounts, netByMonth };
  }

  // ---------------- Budgets ----------------
  async listBudgets() {
    return (await pool.query(
      `SELECT id, name, fiscal_year AS "fiscalYear", created_at AS "createdAt" FROM budgets WHERE org_id = $1 ORDER BY fiscal_year DESC, id DESC`,
      [currentOrgId()]
    )).rows;
  }

  async getBudget(id: number) {
    const b = (await pool.query(`SELECT id, name, fiscal_year AS "fiscalYear" FROM budgets WHERE id = $1 AND org_id = $2`, [id, currentOrgId()])).rows[0];
    if (!b) return undefined;
    const lines = (await pool.query(
      `SELECT bl.id, bl.account_id AS "accountId", a.code, a.name AS "accountName", bl.month, bl.amount
         FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id
        WHERE bl.budget_id = $1 AND bl.org_id = $2 ORDER BY a.code, bl.month`,
      [id, currentOrgId()]
    )).rows;
    return { ...b, lines };
  }

  async createBudget(input: { name: string; fiscalYear: number }) {
    const r = (await pool.query(
      `INSERT INTO budgets (org_id, name, fiscal_year) VALUES ($1, $2, $3) RETURNING id, name, fiscal_year AS "fiscalYear"`,
      [currentOrgId(), input.name, input.fiscalYear]
    )).rows[0];
    await this.audit("create", "budget", Number(r.id), `Created budget "${input.name}" (FY${input.fiscalYear})`);
    return r;
  }

  // Replace-style line upsert: lines for (account, month) are set to the given
  // integer-cent amounts; the UNIQUE(budget_id, account_id, month) key makes
  // this idempotent.
  async setBudgetLines(budgetId: number, lines: Array<{ accountId: number; month: number; amount: number }>) {
    const b = (await pool.query(`SELECT id FROM budgets WHERE id = $1 AND org_id = $2`, [budgetId, currentOrgId()])).rows[0];
    if (!b) throw new Error("Budget not found");
    // Every referenced account must belong to this org.
    for (const l of lines) {
      const a = (await pool.query(`SELECT 1 FROM accounts WHERE id = $1 AND org_id = $2`, [l.accountId, currentOrgId()])).rows[0];
      if (!a) throw new Error(`Account ${l.accountId} not found`);
    }
    await db.transaction(async () => {
      for (const l of lines) {
        await pool.query(
          `INSERT INTO budget_lines (org_id, budget_id, account_id, month, amount)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (budget_id, account_id, month) DO UPDATE SET amount = EXCLUDED.amount`,
          [currentOrgId(), budgetId, l.accountId, l.month, l.amount]
        );
      }
    });
    await this.audit("update", "budget", budgetId, `Set ${lines.length} budget line(s)`);
    return { ok: true };
  }

  async deleteBudget(id: number) {
    const r = await pool.query(`DELETE FROM budgets WHERE id = $1 AND org_id = $2`, [id, currentOrgId()]);
    if ((r.rowCount ?? 0) === 0) throw new Error("Budget not found");
    await this.audit("delete", "budget", id, `Deleted budget #${id}`);
    return { ok: true };
  }

  // Budget vs actual: budget = sum of budget_lines whose month falls inside
  // [from,to] (months of the budget's fiscal year); actual = P&L activity for
  // the same account and range. Variance sign convention: income variance =
  // actual - budget (over-performing is positive); expense variance =
  // budget - actual (underspending is positive) — the convention accountants
  // expect on a management pack.
  async budgetVsActual(budgetId: number, fromDate: string, toDate: string) {
    const budget = (await pool.query(`SELECT id, name, fiscal_year AS "fiscalYear" FROM budgets WHERE id = $1 AND org_id = $2`, [budgetId, currentOrgId()])).rows[0];
    if (!budget) throw new Error("Budget not found");
    const fy = Number(budget.fiscalYear);
    // Which of the budget's months land inside the requested range?
    const monthsInRange: number[] = [];
    for (let m = 1; m <= 12; m++) {
      const monthKey = `${fy}-${String(m).padStart(2, "0")}`;
      if (monthKey >= fromDate.slice(0, 7) && monthKey <= toDate.slice(0, 7)) monthsInRange.push(m);
    }
    const rows = (await pool.query(`
      SELECT a.id AS "accountId", a.code, a.name, a.type,
             COALESCE(bl.budget, 0)::bigint AS budget,
             COALESCE(act.actual, 0)::bigint AS actual
        FROM accounts a
        LEFT JOIN (
          SELECT account_id, SUM(amount) AS budget
            FROM budget_lines
           WHERE budget_id = $1 AND org_id = $2 AND month = ANY($5::int[])
           GROUP BY account_id
        ) bl ON bl.account_id = a.id
        LEFT JOIN (
          SELECT jl.account_id,
                 SUM(CASE WHEN a2.type = 'income' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS actual
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN accounts a2 ON a2.id = jl.account_id
           WHERE je.org_id = $2 AND a2.org_id = $2 AND a2.type IN ('income','expense')
             AND je.date >= $3 AND je.date <= $4
           GROUP BY jl.account_id
        ) act ON act.account_id = a.id
       WHERE a.org_id = $2 AND a.type IN ('income','expense')
         AND (bl.budget IS NOT NULL OR act.actual IS NOT NULL)
       ORDER BY a.code
    `, [budgetId, currentOrgId(), fromDate, toDate, monthsInRange])).rows as any[];
    return {
      budget,
      from: fromDate,
      to: toDate,
      rows: rows.map((r) => {
        const budgetC = Number(r.budget), actualC = Number(r.actual);
        const variance = r.type === "income" ? actualC - budgetC : budgetC - actualC;
        return {
          ...r,
          budget: budgetC,
          actual: actualC,
          variance,
          variancePct: budgetC !== 0 ? Math.round((variance / Math.abs(budgetC)) * 10000) / 100 : null,
        };
      }),
    };
  }
}

export const storage = new DatabaseStorage();
