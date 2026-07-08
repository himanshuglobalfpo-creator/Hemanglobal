/**
 * server/storage.ts — org-scoped storage methods.
 * GLOBAL RULES honored here:
 *  - every query filters by org_id;
 *  - multi-statement writes run inside db.transaction();
 *  - money is integer cents; the GL is 100% org base currency;
 *  - documents in a foreign currency store BOTH foreign cents and base cents
 *    converted at the document-date rate (per-line rounding, then summed).
 */
import crypto from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import {
  insertInvoiceSchema,
  insertBillSchema,
  paymentSchema,
  insertCreditNoteSchema,
} from "../shared/schema.js";
import { convertCents } from "../shared/money.js";

type InvoiceInput = z.infer<typeof insertInvoiceSchema>;
type BillInput = z.infer<typeof insertBillSchema>;
type PaymentInput = z.infer<typeof paymentSchema>;
type CreditNoteInput = z.infer<typeof insertCreditNoteSchema>;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export interface OrgRow {
  id: number;
  name: string;
  base_currency: string;
}
export interface AccountRow {
  id: number;
  org_id: number;
  code: string;
  name: string;
  type: string;
  subtype: string;
  is_active: number;
}
export interface InvoiceRow {
  id: number;
  org_id: number;
  customer_id: number;
  number: string;
  date: string;
  due_date: string;
  status: string;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  journal_entry_id: number | null;
  currency: string;
  fx_rate: number;
  foreign_subtotal: number;
  foreign_tax: number;
  foreign_total: number;
  foreign_amount_paid: number;
}
export type BillRow = Omit<InvoiceRow, "customer_id"> & { vendor_id: number };

/* ------------------------------------------------------------------ */
/* Org + chart of accounts                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_ACCOUNTS: Array<[string, string, string, string]> = [
  ["1000", "Bank", "asset", "bank"],
  ["1100", "Accounts Receivable", "asset", "accounts_receivable"],
  ["1500", "Fixed Assets", "asset", "fixed_asset"],
  ["2000", "Accounts Payable", "liability", "accounts_payable"],
  ["2100", "Sales Tax Payable", "liability", "current_liability"],
  ["3000", "Opening Balance Equity", "equity", "equity"],
  ["3900", "Retained Earnings", "equity", "equity"],
  ["4000", "Sales", "income", "sales"],
  ["5000", "Cost of Goods Sold", "expense", "cost_of_goods_sold"],
  ["6000", "General Expense", "expense", "operating_expense"],
];

/** TASK 1: idempotent FX account seeds — safe to call on every boot/org. */
export function ensureFxAccounts(orgId: number): void {
  const seed = db.prepare(
    `INSERT INTO accounts (org_id, code, name, type, subtype)
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE org_id = ? AND code = ?)`,
  );
  seed.run(orgId, "4950", "FX Gain", "income", "other_income", orgId, "4950");
  seed.run(orgId, "6950", "FX Loss", "expense", "other_expense", orgId, "6950");
}

export function seedChartOfAccounts(orgId: number): void {
  const seed = db.prepare(
    `INSERT INTO accounts (org_id, code, name, type, subtype)
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE org_id = ? AND code = ?)`,
  );
  for (const [code, name, type, subtype] of DEFAULT_ACCOUNTS) {
    seed.run(orgId, code, name, type, subtype, orgId, code);
  }
  ensureFxAccounts(orgId);
}

export function getOrg(orgId: number): OrgRow {
  const org = db.prepare("SELECT id, name, base_currency FROM orgs WHERE id = ?").get(orgId) as OrgRow | undefined;
  if (!org) throw new HttpError(404, "org not found");
  return org;
}

export function accountByCode(orgId: number, code: string): AccountRow {
  const row = db.prepare("SELECT * FROM accounts WHERE org_id = ? AND code = ?").get(orgId, code) as
    | AccountRow
    | undefined;
  if (!row) throw new HttpError(500, `system account ${code} missing for org ${orgId}`);
  return row;
}

export function accountById(orgId: number, id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE org_id = ? AND id = ?").get(orgId, id) as AccountRow | undefined;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export function audit(
  orgId: number,
  userId: number | null,
  action: string,
  entityType: string,
  entityId: number | null,
  summary: string,
): void {
  db.prepare(
    "INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, summary) VALUES (?,?,?,?,?,?)",
  ).run(orgId, userId, action, entityType, entityId, summary);
}

/* ------------------------------------------------------------------ */
/* Closed-period guard                                                 */
/* ------------------------------------------------------------------ */

export function assertPeriodOpen(orgId: number, date: string): void {
  const row = db
    .prepare("SELECT MAX(through_date) AS through FROM closed_periods WHERE org_id = ?")
    .get(orgId) as { through: string | null };
  if (row.through && date <= row.through) {
    throw new HttpError(409, `period closed through ${row.through}`, "PERIOD_CLOSED");
  }
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

export interface JournalLineInput {
  accountId: number;
  debit: number;
  credit: number;
}

/** Inserts a balanced journal entry. Caller must already be inside a tx. */
export function postJournalEntry(
  orgId: number,
  date: string,
  memo: string,
  source: string,
  sourceId: number | null,
  lines: JournalLineInput[],
): number {
  const clean = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  const dr = clean.reduce((s, l) => s + l.debit, 0);
  const cr = clean.reduce((s, l) => s + l.credit, 0);
  if (dr !== cr) throw new HttpError(500, `unbalanced journal entry: DR ${dr} != CR ${cr}`);
  if (clean.length === 0) throw new HttpError(400, "journal entry has no lines");
  const entry = db
    .prepare("INSERT INTO journal_entries (org_id, date, memo, source, source_id) VALUES (?,?,?,?,?)")
    .run(orgId, date, memo, source, sourceId);
  const entryId = Number(entry.lastInsertRowid);
  const insLine = db.prepare(
    "INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES (?,?,?,?,?)",
  );
  for (const l of clean) insLine.run(orgId, entryId, l.accountId, l.debit, l.credit);
  return entryId;
}

/* ------------------------------------------------------------------ */
/* FX rates — TASK 1                                                   */
/* ------------------------------------------------------------------ */

export function upsertFxRate(orgId: number, date: string, fromCode: string, toCode: string, rate: number, source = "manual"): void {
  db.prepare(
    `INSERT INTO fx_rates (org_id, date, from_code, to_code, rate, source) VALUES (?,?,?,?,?,?)
     ON CONFLICT(org_id, date, from_code, to_code) DO UPDATE SET rate = excluded.rate, source = excluded.source`,
  ).run(orgId, date, fromCode, toCode, rate, source);
}

export function listFxRates(orgId: number, limit = 500): unknown[] {
  return db
    .prepare("SELECT date, from_code AS fromCode, to_code AS toCode, rate, source FROM fx_rates WHERE org_id = ? ORDER BY date DESC LIMIT ?")
    .all(orgId, limit);
}

/** Latest stored rate on or before `date`, or undefined. */
export function lookupFxRate(orgId: number, date: string, fromCode: string, toCode: string): number | undefined {
  const row = db
    .prepare(
      `SELECT rate FROM fx_rates WHERE org_id = ? AND from_code = ? AND to_code = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`,
    )
    .get(orgId, fromCode, toCode, date) as { rate: number } | undefined;
  return row?.rate;
}

/* ------------------------------------------------------------------ */
/* Document currency resolution — TASK 1                               */
/* ------------------------------------------------------------------ */

interface ResolvedCurrency {
  /** '' means "base currency document" (legacy-compatible sentinel) */
  currency: string;
  fxRate: number;
  isForeign: boolean;
}

function resolveDocCurrency(orgId: number, input: { currency?: string; fxRate?: number; date: string }): ResolvedCurrency {
  const base = getOrg(orgId).base_currency;
  const cur = input.currency && input.currency !== base ? input.currency : "";
  if (!cur) return { currency: "", fxRate: 1, isForeign: false };
  // Rate is required for foreign documents: explicit beats stored table.
  const rate = input.fxRate ?? lookupFxRate(orgId, input.date, cur, base);
  if (!rate || !(rate > 0)) {
    throw new HttpError(400, `fxRate required for ${cur} document (no stored rate on/before ${input.date})`, "FX_RATE_REQUIRED");
  }
  return { currency: cur, fxRate: rate, isForeign: true };
}

/* ------------------------------------------------------------------ */
/* Invoices — TASK 1 aware                                             */
/* ------------------------------------------------------------------ */

function nextDocNumber(orgId: number, table: "invoices" | "bills" | "credit_notes", prefix: string): string {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`).get(orgId) as { n: number };
  let n = row.n + 1;
  // Skip over collisions from imported/custom numbers.
  for (;;) {
    const candidate = `${prefix}-${String(n).padStart(5, "0")}`;
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE org_id = ? AND number = ?`).get(orgId, candidate);
    if (!exists) return candidate;
    n++;
  }
}

interface ComputedLine {
  description: string;
  quantity: number;
  rate: number;
  taxRate: number;
  accountId: number;
  foreignAmount: number; // document-currency cents (== base when not foreign)
  foreignTax: number;
  baseAmount: number; // base-currency cents at the document-date rate
  baseTax: number;
}

/**
 * Line math discipline (same as pre-FX code): round PER LINE, then sum.
 * For foreign documents each line's base cents = round(foreignCents * fxRate)
 * — rounded per line THEN summed, so totals always equal the sum of lines.
 */
function computeLines(lines: InvoiceInput["lines"], fx: ResolvedCurrency): ComputedLine[] {
  return lines.map((l) => {
    const foreignAmount = Math.round(l.quantity * l.rate);
    const foreignTax = Math.round((foreignAmount * (l.taxRate ?? 0)) / 100);
    const baseAmount = fx.isForeign ? convertCents(foreignAmount, fx.fxRate) : foreignAmount;
    const baseTax = fx.isForeign ? convertCents(foreignTax, fx.fxRate) : foreignTax;
    return {
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      taxRate: l.taxRate ?? 0,
      accountId: l.accountId,
      foreignAmount,
      foreignTax,
      baseAmount,
      baseTax,
    };
  });
}

export function createInvoice(orgId: number, userId: number, raw: unknown): InvoiceRow {
  const input = insertInvoiceSchema.parse(raw);
  assertPeriodOpen(orgId, input.date);
  const customer = db
    .prepare("SELECT * FROM customers WHERE org_id = ? AND id = ?")
    .get(orgId, input.customerId) as { id: number; name: string; currency: string | null } | undefined;
  if (!customer) throw new HttpError(404, "customer not found");

  // Customer's currency is the default document currency when none is given.
  const wanted = input.currency ?? customer.currency ?? undefined;
  const fx = resolveDocCurrency(orgId, { currency: wanted, fxRate: input.fxRate, date: input.date });

  for (const l of input.lines) {
    const acct = accountById(orgId, l.accountId);
    if (!acct) throw new HttpError(400, `line account ${l.accountId} not found in org`);
  }

  const computed = computeLines(input.lines, fx);
  const foreignSubtotal = computed.reduce((s, l) => s + l.foreignAmount, 0);
  const foreignTax = computed.reduce((s, l) => s + l.foreignTax, 0);
  const foreignTotal = foreignSubtotal + foreignTax;
  const baseSubtotal = computed.reduce((s, l) => s + l.baseAmount, 0);
  const baseTax = computed.reduce((s, l) => s + l.baseTax, 0);
  const baseTotal = baseSubtotal + baseTax;

  const ar = accountByCode(orgId, "1100");
  const taxAcct = accountByCode(orgId, "2100");
  const number = input.number ?? nextDocNumber(orgId, "invoices", "INV");

  const run = db.transaction((): number => {
    const res = db
      .prepare(
        `INSERT INTO invoices (org_id, customer_id, number, date, due_date, status, subtotal, tax, total, amount_paid,
                               currency, fx_rate, foreign_subtotal, foreign_tax, foreign_total, foreign_amount_paid)
         VALUES (?,?,?,?,?,'open',?,?,?,0,?,?,?,?,?,0)`,
      )
      .run(
        orgId, input.customerId, number, input.date, input.dueDate,
        baseSubtotal, baseTax, baseTotal,
        fx.currency, fx.fxRate,
        fx.isForeign ? foreignSubtotal : 0, fx.isForeign ? foreignTax : 0, fx.isForeign ? foreignTotal : 0,
      );
    const invoiceId = Number(res.lastInsertRowid);
    const insLine = db.prepare(
      `INSERT INTO invoice_lines (org_id, invoice_id, description, quantity, rate, tax_rate, amount, account_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    // The GL posts BASE cents only: DR A/R total; CR income per line; CR tax.
    const jl: JournalLineInput[] = [{ accountId: ar.id, debit: baseTotal, credit: 0 }];
    for (const l of computed) {
      insLine.run(orgId, invoiceId, l.description, l.quantity, l.rate, l.taxRate, l.foreignAmount, l.accountId);
      jl.push({ accountId: l.accountId, debit: 0, credit: l.baseAmount });
    }
    if (baseTax > 0) jl.push({ accountId: taxAcct.id, debit: 0, credit: baseTax });
    const jeId = postJournalEntry(orgId, input.date, `Invoice ${number} — ${customer.name}`, "invoice", invoiceId, jl);
    db.prepare("UPDATE invoices SET journal_entry_id = ? WHERE id = ? AND org_id = ?").run(jeId, invoiceId, orgId);
    audit(orgId, userId, "create", "invoice", invoiceId, `Invoice ${number} for ${customer.name}${fx.isForeign ? ` (${fx.currency} @ ${fx.fxRate})` : ""}`);
    return invoiceId;
  });
  const id = run();
  return getInvoice(orgId, id);
}

export function getInvoice(orgId: number, id: number): InvoiceRow {
  const row = db.prepare("SELECT * FROM invoices WHERE org_id = ? AND id = ?").get(orgId, id) as InvoiceRow | undefined;
  if (!row) throw new HttpError(404, "invoice not found");
  return row;
}

export function listInvoices(orgId: number, page: number, pageSize: number, status?: string): { rows: unknown[]; total: number } {
  const where = status ? "i.org_id = ? AND i.status = ?" : "i.org_id = ?";
  const params: unknown[] = status ? [orgId, status] : [orgId];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM invoices i WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS customer_name FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE ${where}
       ORDER BY i.date DESC, i.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total };
}

export function invoiceLines(orgId: number, invoiceId: number): unknown[] {
  return db.prepare("SELECT * FROM invoice_lines WHERE org_id = ? AND invoice_id = ?").all(orgId, invoiceId);
}

/**
 * TASK 1 — payInvoice with realized FX gain/loss.
 *
 * Worked example (the acceptance case):
 *   EUR invoice, foreign_total €100.00 (10000¢), document rate 1.10
 *     → invoice booked: DR A/R $110.00 / CR Sales $110.00
 *   Payment of €100.00 at payment rate 1.08:
 *     baseRelieved = round(10000 × 1.10) = 11000¢  (A/R relieved at DOCUMENT rate)
 *     baseReceived = round(10000 × 1.08) = 10800¢  (cash at PAYMENT rate)
 *     JE:  DR Bank    10800
 *          DR FX Loss   200   (we received less base value than A/R carried)
 *          CR A/R     11000
 *   Had the rate risen to 1.12: baseReceived 11200 → CR FX Gain 200 instead.
 */
export function payInvoice(orgId: number, userId: number, invoiceId: number, raw: unknown): InvoiceRow {
  const input: PaymentInput = paymentSchema.parse(raw);
  const invoice = getInvoice(orgId, invoiceId);
  if (invoice.status === "void") throw new HttpError(409, "cannot pay a voided invoice");
  if (invoice.status === "paid") throw new HttpError(409, "invoice already paid");
  assertPeriodOpen(orgId, input.date);

  const bank = accountById(orgId, input.bankAccountId);
  if (!bank || bank.subtype !== "bank") throw new HttpError(400, "bankAccountId must be a bank account in this org");
  const ar = accountByCode(orgId, "1100");
  const isForeign = invoice.currency !== "";

  let baseRelieved: number;
  let baseReceived: number;
  let foreignApplied = 0;

  if (isForeign) {
    if (input.foreignAmount === undefined || input.fxRate === undefined) {
      throw new HttpError(400, "foreignAmount and fxRate are required to pay a foreign-currency invoice", "FX_PAYMENT_FIELDS_REQUIRED");
    }
    foreignApplied = input.foreignAmount;
    const outstandingForeign = invoice.foreign_total - invoice.foreign_amount_paid;
    if (foreignApplied <= 0 || foreignApplied > outstandingForeign) {
      throw new HttpError(400, `foreignAmount must be 1..${outstandingForeign} (${invoice.currency} cents outstanding)`);
    }
    // A/R is relieved proportionally at the DOCUMENT rate; cash lands at the
    // PAYMENT rate; the difference is realized FX gain/loss.
    baseRelieved = convertCents(foreignApplied, invoice.fx_rate);
    // Final payment: relieve the exact remaining base balance so per-payment
    // rounding can never strand a 1¢ A/R residue.
    if (foreignApplied === outstandingForeign) baseRelieved = invoice.total - invoice.amount_paid;
    baseReceived = convertCents(foreignApplied, input.fxRate);
  } else {
    if (input.amount === undefined) throw new HttpError(400, "amount (base cents) is required");
    const outstanding = invoice.total - invoice.amount_paid;
    if (input.amount <= 0 || input.amount > outstanding) {
      throw new HttpError(400, `amount must be 1..${outstanding} cents outstanding`);
    }
    baseRelieved = input.amount;
    baseReceived = input.amount;
  }

  const fxDiff = baseRelieved - baseReceived; // >0 = loss, <0 = gain
  const fxLoss = fxDiff > 0 ? accountByCode(orgId, "6950") : null;
  const fxGain = fxDiff < 0 ? accountByCode(orgId, "4950") : null;

  const run = db.transaction(() => {
    const jl: JournalLineInput[] = [
      { accountId: bank.id, debit: baseReceived, credit: 0 },
      { accountId: ar.id, debit: 0, credit: baseRelieved },
    ];
    if (fxLoss) jl.push({ accountId: fxLoss.id, debit: fxDiff, credit: 0 });
    if (fxGain) jl.push({ accountId: fxGain.id, debit: 0, credit: -fxDiff });
    postJournalEntry(orgId, input.date, `Payment for invoice ${invoice.number}`, "invoice_payment", invoice.id, jl);

    const newPaid = invoice.amount_paid + baseRelieved;
    const newForeignPaid = invoice.foreign_amount_paid + foreignApplied;
    const settled = isForeign ? newForeignPaid >= invoice.foreign_total : newPaid >= invoice.total;
    db.prepare(
      "UPDATE invoices SET amount_paid = ?, foreign_amount_paid = ?, status = ? WHERE id = ? AND org_id = ?",
    ).run(newPaid, newForeignPaid, settled ? "paid" : "partial", invoice.id, orgId);
    audit(
      orgId, userId, "pay", "invoice", invoice.id,
      isForeign
        ? `Payment ${invoice.currency} ${(foreignApplied / 100).toFixed(2)} @ ${input.fxRate} on ${invoice.number} (fx ${fxDiff > 0 ? "loss" : fxDiff < 0 ? "gain" : "none"} ${Math.abs(fxDiff)}¢)`
        : `Payment ${(baseReceived / 100).toFixed(2)} on ${invoice.number}`,
    );
  });
  run();
  return getInvoice(orgId, invoiceId);
}

export function voidInvoice(orgId: number, userId: number, invoiceId: number): InvoiceRow {
  const invoice = getInvoice(orgId, invoiceId);
  if (invoice.status === "void") throw new HttpError(409, "already void");
  if (invoice.amount_paid > 0 || invoice.foreign_amount_paid > 0) {
    throw new HttpError(409, "cannot void an invoice with payments applied");
  }
  const today = new Date().toISOString().slice(0, 10);
  assertPeriodOpen(orgId, today);
  const run = db.transaction(() => {
    // Reversing entry: mirror every line of the original JE.
    if (invoice.journal_entry_id) {
      const lines = db
        .prepare("SELECT account_id, debit, credit FROM journal_lines WHERE org_id = ? AND entry_id = ?")
        .all(orgId, invoice.journal_entry_id) as Array<{ account_id: number; debit: number; credit: number }>;
      postJournalEntry(
        orgId, today, `Void invoice ${invoice.number}`, "invoice_void", invoice.id,
        lines.map((l) => ({ accountId: l.account_id, debit: l.credit, credit: l.debit })),
      );
    }
    db.prepare("UPDATE invoices SET status = 'void' WHERE id = ? AND org_id = ?").run(invoice.id, orgId);
    audit(orgId, userId, "void", "invoice", invoice.id, `Voided invoice ${invoice.number}`);
  });
  run();
  return getInvoice(orgId, invoiceId);
}

/* ------------------------------------------------------------------ */
/* Bills — mirrors invoices                                            */
/* ------------------------------------------------------------------ */

export function createBill(orgId: number, userId: number, raw: unknown): BillRow {
  const input = insertBillSchema.parse(raw);
  assertPeriodOpen(orgId, input.date);
  const vendor = db
    .prepare("SELECT * FROM vendors WHERE org_id = ? AND id = ?")
    .get(orgId, input.vendorId) as { id: number; name: string; currency: string | null } | undefined;
  if (!vendor) throw new HttpError(404, "vendor not found");

  const wanted = input.currency ?? vendor.currency ?? undefined;
  const fx = resolveDocCurrency(orgId, { currency: wanted, fxRate: input.fxRate, date: input.date });

  for (const l of input.lines) {
    if (!accountById(orgId, l.accountId)) throw new HttpError(400, `line account ${l.accountId} not found in org`);
  }

  const computed = computeLines(input.lines, fx);
  const foreignSubtotal = computed.reduce((s, l) => s + l.foreignAmount, 0);
  const foreignTax = computed.reduce((s, l) => s + l.foreignTax, 0);
  const foreignTotal = foreignSubtotal + foreignTax;
  const baseSubtotal = computed.reduce((s, l) => s + l.baseAmount, 0);
  const baseTax = computed.reduce((s, l) => s + l.baseTax, 0);
  const baseTotal = baseSubtotal + baseTax;

  const ap = accountByCode(orgId, "2000");
  const taxAcct = accountByCode(orgId, "2100");
  const number = input.number ?? nextDocNumber(orgId, "bills", "BILL");

  const run = db.transaction((): number => {
    const res = db
      .prepare(
        `INSERT INTO bills (org_id, vendor_id, number, date, due_date, status, subtotal, tax, total, amount_paid,
                            currency, fx_rate, foreign_subtotal, foreign_tax, foreign_total, foreign_amount_paid)
         VALUES (?,?,?,?,?,'open',?,?,?,0,?,?,?,?,?,0)`,
      )
      .run(
        orgId, input.vendorId, number, input.date, input.dueDate,
        baseSubtotal, baseTax, baseTotal,
        fx.currency, fx.fxRate,
        fx.isForeign ? foreignSubtotal : 0, fx.isForeign ? foreignTax : 0, fx.isForeign ? foreignTotal : 0,
      );
    const billId = Number(res.lastInsertRowid);
    const insLine = db.prepare(
      `INSERT INTO bill_lines (org_id, bill_id, description, quantity, rate, tax_rate, amount, account_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    // GL (base cents): DR expense per line (+ DR tax), CR A/P total.
    const jl: JournalLineInput[] = [{ accountId: ap.id, debit: 0, credit: baseTotal }];
    for (const l of computed) {
      insLine.run(orgId, billId, l.description, l.quantity, l.rate, l.taxRate, l.foreignAmount, l.accountId);
      jl.push({ accountId: l.accountId, debit: l.baseAmount, credit: 0 });
    }
    if (baseTax > 0) jl.push({ accountId: taxAcct.id, debit: baseTax, credit: 0 });
    const jeId = postJournalEntry(orgId, input.date, `Bill ${number} — ${vendor.name}`, "bill", billId, jl);
    db.prepare("UPDATE bills SET journal_entry_id = ? WHERE id = ? AND org_id = ?").run(jeId, billId, orgId);
    audit(orgId, userId, "create", "bill", billId, `Bill ${number} from ${vendor.name}${fx.isForeign ? ` (${fx.currency} @ ${fx.fxRate})` : ""}`);
    return billId;
  });
  const id = run();
  return getBill(orgId, id);
}

export function getBill(orgId: number, id: number): BillRow {
  const row = db.prepare("SELECT * FROM bills WHERE org_id = ? AND id = ?").get(orgId, id) as BillRow | undefined;
  if (!row) throw new HttpError(404, "bill not found");
  return row;
}

export function listBills(orgId: number, page: number, pageSize: number, status?: string): { rows: unknown[]; total: number } {
  const where = status ? "b.org_id = ? AND b.status = ?" : "b.org_id = ?";
  const params: unknown[] = status ? [orgId, status] : [orgId];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM bills b WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT b.*, v.name AS vendor_name FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
       WHERE ${where} ORDER BY b.date DESC, b.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total };
}

export function billLines(orgId: number, billId: number): unknown[] {
  return db.prepare("SELECT * FROM bill_lines WHERE org_id = ? AND bill_id = ?").all(orgId, billId);
}

/**
 * TASK 1 — payBill, mirror of payInvoice.
 *
 * Worked example: EUR bill €100 @ 1.10 → A/P carries $110.00.
 *   Pay €100 @ 1.08: baseRelieved = 11000¢, basePaid = 10800¢
 *     DR A/P    11000
 *     CR Bank   10800
 *     CR FX Gain  200   (liability settled for less base cash → gain)
 *   Rate 1.12 instead: basePaid 11200 → DR FX Loss 200.
 */
export function payBill(orgId: number, userId: number, billId: number, raw: unknown): BillRow {
  const input: PaymentInput = paymentSchema.parse(raw);
  const bill = getBill(orgId, billId);
  if (bill.status === "void") throw new HttpError(409, "cannot pay a voided bill");
  if (bill.status === "paid") throw new HttpError(409, "bill already paid");
  assertPeriodOpen(orgId, input.date);

  const bank = accountById(orgId, input.bankAccountId);
  if (!bank || bank.subtype !== "bank") throw new HttpError(400, "bankAccountId must be a bank account in this org");
  const ap = accountByCode(orgId, "2000");
  const isForeign = bill.currency !== "";

  let baseRelieved: number;
  let basePaid: number;
  let foreignApplied = 0;

  if (isForeign) {
    if (input.foreignAmount === undefined || input.fxRate === undefined) {
      throw new HttpError(400, "foreignAmount and fxRate are required to pay a foreign-currency bill", "FX_PAYMENT_FIELDS_REQUIRED");
    }
    foreignApplied = input.foreignAmount;
    const outstandingForeign = bill.foreign_total - bill.foreign_amount_paid;
    if (foreignApplied <= 0 || foreignApplied > outstandingForeign) {
      throw new HttpError(400, `foreignAmount must be 1..${outstandingForeign} (${bill.currency} cents outstanding)`);
    }
    baseRelieved = convertCents(foreignApplied, bill.fx_rate);
    if (foreignApplied === outstandingForeign) baseRelieved = bill.total - bill.amount_paid;
    basePaid = convertCents(foreignApplied, input.fxRate);
  } else {
    if (input.amount === undefined) throw new HttpError(400, "amount (base cents) is required");
    const outstanding = bill.total - bill.amount_paid;
    if (input.amount <= 0 || input.amount > outstanding) throw new HttpError(400, `amount must be 1..${outstanding} cents outstanding`);
    baseRelieved = input.amount;
    basePaid = input.amount;
  }

  const fxDiff = baseRelieved - basePaid; // >0 = gain (paid less), <0 = loss
  const fxGain = fxDiff > 0 ? accountByCode(orgId, "4950") : null;
  const fxLoss = fxDiff < 0 ? accountByCode(orgId, "6950") : null;

  const run = db.transaction(() => {
    const jl: JournalLineInput[] = [
      { accountId: ap.id, debit: baseRelieved, credit: 0 },
      { accountId: bank.id, debit: 0, credit: basePaid },
    ];
    if (fxGain) jl.push({ accountId: fxGain.id, debit: 0, credit: fxDiff });
    if (fxLoss) jl.push({ accountId: fxLoss.id, debit: -fxDiff, credit: 0 });
    postJournalEntry(orgId, input.date, `Payment for bill ${bill.number}`, "bill_payment", bill.id, jl);

    const newPaid = bill.amount_paid + baseRelieved;
    const newForeignPaid = bill.foreign_amount_paid + foreignApplied;
    const settled = isForeign ? newForeignPaid >= bill.foreign_total : newPaid >= bill.total;
    db.prepare("UPDATE bills SET amount_paid = ?, foreign_amount_paid = ?, status = ? WHERE id = ? AND org_id = ?")
      .run(newPaid, newForeignPaid, settled ? "paid" : "partial", bill.id, orgId);
    audit(
      orgId, userId, "pay", "bill", bill.id,
      isForeign
        ? `Payment ${bill.currency} ${(foreignApplied / 100).toFixed(2)} @ ${input.fxRate} on ${bill.number} (fx ${fxDiff > 0 ? "gain" : fxDiff < 0 ? "loss" : "none"} ${Math.abs(fxDiff)}¢)`
        : `Payment ${(basePaid / 100).toFixed(2)} on ${bill.number}`,
    );
  });
  run();
  return getBill(orgId, billId);
}

/* ------------------------------------------------------------------ */
/* Credit notes (base currency only in this phase)                     */
/* ------------------------------------------------------------------ */

export function createCreditNote(orgId: number, userId: number, raw: unknown): { id: number; number: string; total: number } {
  const input: CreditNoteInput = insertCreditNoteSchema.parse(raw);
  assertPeriodOpen(orgId, input.date);
  const customer = db.prepare("SELECT id, name FROM customers WHERE org_id = ? AND id = ?").get(orgId, input.customerId) as
    | { id: number; name: string }
    | undefined;
  if (!customer) throw new HttpError(404, "customer not found");
  if (input.invoiceId) getInvoice(orgId, input.invoiceId); // org check
  for (const l of input.lines) {
    if (!accountById(orgId, l.accountId)) throw new HttpError(400, `line account ${l.accountId} not found in org`);
  }
  const computed = computeLines(input.lines, { currency: "", fxRate: 1, isForeign: false });
  const total = computed.reduce((s, l) => s + l.baseAmount + l.baseTax, 0);
  const taxTotal = computed.reduce((s, l) => s + l.baseTax, 0);
  const ar = accountByCode(orgId, "1100");
  const taxAcct = accountByCode(orgId, "2100");
  const number = nextDocNumber(orgId, "credit_notes", "CN");

  const run = db.transaction((): number => {
    const res = db
      .prepare("INSERT INTO credit_notes (org_id, customer_id, invoice_id, number, date, total) VALUES (?,?,?,?,?,?)")
      .run(orgId, input.customerId, input.invoiceId ?? null, number, input.date, total);
    const cnId = Number(res.lastInsertRowid);
    const jl: JournalLineInput[] = [{ accountId: ar.id, debit: 0, credit: total }];
    for (const l of computed) jl.push({ accountId: l.accountId, debit: l.baseAmount, credit: 0 });
    if (taxTotal > 0) jl.push({ accountId: taxAcct.id, debit: taxTotal, credit: 0 });
    const jeId = postJournalEntry(orgId, input.date, `Credit note ${number} — ${customer.name}`, "credit_note", cnId, jl);
    db.prepare("UPDATE credit_notes SET journal_entry_id = ? WHERE id = ? AND org_id = ?").run(jeId, cnId, orgId);
    audit(orgId, userId, "create", "credit_note", cnId, `Credit note ${number} for ${customer.name}`);
    return cnId;
  });
  const id = run();
  return { id, number, total };
}

/* ------------------------------------------------------------------ */
/* Reports — TASK 4                                                    */
/* ------------------------------------------------------------------ */

export function trialBalance(orgId: number, asOf?: string): Array<{ code: string; name: string; type: string; debit: number; credit: number }> {
  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.org_id = a.org_id
       LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = a.org_id
       WHERE a.org_id = ? AND (je.id IS NULL OR ? IS NULL OR je.date <= ?)
       GROUP BY a.id ORDER BY a.code`,
    )
    .all(orgId, asOf ?? null, asOf ?? null) as Array<{ code: string; name: string; type: string; dr: number; cr: number }>;
  return rows.map((r) => {
    const net = r.dr - r.cr;
    return { code: r.code, name: r.name, type: r.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
}

export interface SalesByCustomerRow {
  customerId: number;
  customer: string;
  invoiced: number;
  credited: number;
  net: number;
  paid: number;
  balance: number;
}

/** TASK 4a — base-currency cents throughout (GL discipline). */
export function salesByCustomer(orgId: number, from?: string, to?: string): SalesByCustomerRow[] {
  const lo = from ?? "0000-01-01";
  const hi = to ?? "9999-12-31";
  return db
    .prepare(
      `SELECT c.id AS customerId, c.name AS customer,
              COALESCE(inv.invoiced, 0) AS invoiced,
              COALESCE(cn.credited, 0) AS credited,
              COALESCE(inv.invoiced, 0) - COALESCE(cn.credited, 0) AS net,
              COALESCE(inv.paid, 0) AS paid,
              COALESCE(inv.invoiced, 0) - COALESCE(cn.credited, 0) - COALESCE(inv.paid, 0) AS balance
       FROM customers c
       LEFT JOIN (SELECT customer_id, SUM(total) AS invoiced, SUM(amount_paid) AS paid
                  FROM invoices WHERE org_id = ? AND status != 'void' AND date BETWEEN ? AND ?
                  GROUP BY customer_id) inv ON inv.customer_id = c.id
       LEFT JOIN (SELECT customer_id, SUM(total) AS credited
                  FROM credit_notes WHERE org_id = ? AND date BETWEEN ? AND ?
                  GROUP BY customer_id) cn ON cn.customer_id = c.id
       WHERE c.org_id = ? AND (inv.invoiced IS NOT NULL OR cn.credited IS NOT NULL)
       ORDER BY net DESC`,
    )
    .all(orgId, lo, hi, orgId, lo, hi, orgId) as SalesByCustomerRow[];
}

export interface ExpensesByVendorRow {
  vendorId: number;
  vendor: string;
  billed: number;
  paid: number;
  balance: number;
}

/** TASK 4b */
export function expensesByVendor(orgId: number, from?: string, to?: string): ExpensesByVendorRow[] {
  const lo = from ?? "0000-01-01";
  const hi = to ?? "9999-12-31";
  return db
    .prepare(
      `SELECT v.id AS vendorId, v.name AS vendor,
              COALESCE(b.billed, 0) AS billed, COALESCE(b.paid, 0) AS paid,
              COALESCE(b.billed, 0) - COALESCE(b.paid, 0) AS balance
       FROM vendors v
       JOIN (SELECT vendor_id, SUM(total) AS billed, SUM(amount_paid) AS paid
             FROM bills WHERE org_id = ? AND status != 'void' AND date BETWEEN ? AND ?
             GROUP BY vendor_id) b ON b.vendor_id = v.id
       WHERE v.org_id = ? ORDER BY billed DESC`,
    )
    .all(orgId, lo, hi, orgId) as ExpensesByVendorRow[];
}

export interface PlMonthlyResult {
  months: string[]; // "YYYY-MM"
  rows: Array<{ code: string; name: string; type: string; amounts: Record<string, number> }>;
}

/**
 * TASK 4c — P&L by month. journal_entries.date is TEXT "YYYY-MM-DD", so
 * substr(date, 1, 7) is an EXACT calendar-month bucket (no timezone math),
 * equivalent to date_trunc('month', ...) on a timestamp column.
 */
export function profitLossMonthly(orgId: number, from?: string, to?: string): PlMonthlyResult {
  const lo = from ?? "0000-01-01";
  const hi = to ?? "9999-12-31";
  const raw = db
    .prepare(
      `SELECT a.code, a.name, a.type, substr(je.date, 1, 7) AS month,
              SUM(CASE WHEN a.type = 'income' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS amount
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = jl.org_id
       JOIN accounts a ON a.id = jl.account_id AND a.org_id = jl.org_id
       WHERE jl.org_id = ? AND a.type IN ('income','expense') AND je.date BETWEEN ? AND ?
       GROUP BY a.id, month ORDER BY a.code, month`,
    )
    .all(orgId, lo, hi) as Array<{ code: string; name: string; type: string; month: string; amount: number }>;

  const months = [...new Set(raw.map((r) => r.month))].sort();
  const byAccount = new Map<string, { code: string; name: string; type: string; amounts: Record<string, number> }>();
  for (const r of raw) {
    let acct = byAccount.get(r.code);
    if (!acct) {
      acct = { code: r.code, name: r.name, type: r.type, amounts: {} };
      byAccount.set(r.code, acct);
    }
    acct.amounts[r.month] = r.amount;
  }
  return { months, rows: [...byAccount.values()] };
}

export interface BudgetVsActualRow {
  code: string;
  name: string;
  type: string;
  budget: number;
  actual: number;
  variance: number;
  variancePct: number | null;
}

/** TASK 4d — actual comes from the same aggregation as the P&L, so it ties. */
export function budgetVsActual(orgId: number, budgetId: number, from?: string, to?: string): BudgetVsActualRow[] {
  const budget = db.prepare("SELECT * FROM budgets WHERE org_id = ? AND id = ?").get(orgId, budgetId) as
    | { id: number; fiscal_year: number }
    | undefined;
  if (!budget) throw new HttpError(404, "budget not found");
  const lo = from ?? `${budget.fiscal_year}-01-01`;
  const hi = to ?? `${budget.fiscal_year}-12-31`;

  // Budget cents for the months of the fiscal year overlapping [lo, hi].
  const monthKey = (m: number) => `${budget.fiscal_year}-${String(m).padStart(2, "0")}`;
  const monthsInRange = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => {
    const key = monthKey(m);
    return key >= lo.slice(0, 7) && key <= hi.slice(0, 7);
  });

  const budgetRows = db
    .prepare(
      `SELECT bl.account_id, a.code, a.name, a.type, SUM(bl.amount) AS budget
       FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id AND a.org_id = bl.org_id
       WHERE bl.org_id = ? AND bl.budget_id = ? AND bl.month IN (${monthsInRange.map(() => "?").join(",") || "NULL"})
       GROUP BY bl.account_id`,
    )
    .all(orgId, budgetId, ...monthsInRange) as Array<{ account_id: number; code: string; name: string; type: string; budget: number }>;

  const actualRows = db
    .prepare(
      `SELECT a.id AS account_id, a.code, a.name, a.type,
              SUM(CASE WHEN a.type = 'income' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS actual
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = jl.org_id
       JOIN accounts a ON a.id = jl.account_id AND a.org_id = jl.org_id
       WHERE jl.org_id = ? AND a.type IN ('income','expense') AND je.date BETWEEN ? AND ?
       GROUP BY a.id`,
    )
    .all(orgId, lo, hi) as Array<{ account_id: number; code: string; name: string; type: string; actual: number }>;

  const merged = new Map<number, BudgetVsActualRow & { accountId: number }>();
  for (const b of budgetRows) {
    merged.set(b.account_id, { accountId: b.account_id, code: b.code, name: b.name, type: b.type, budget: b.budget, actual: 0, variance: 0, variancePct: null });
  }
  for (const a of actualRows) {
    const row = merged.get(a.account_id) ?? { accountId: a.account_id, code: a.code, name: a.name, type: a.type, budget: 0, actual: 0, variance: 0, variancePct: null };
    row.actual = a.actual;
    merged.set(a.account_id, row);
  }
  return [...merged.values()]
    .map((r) => {
      // Favorable = income above budget / expense below budget.
      const variance = r.type === "income" ? r.actual - r.budget : r.budget - r.actual;
      return { code: r.code, name: r.name, type: r.type, budget: r.budget, actual: r.actual, variance, variancePct: r.budget !== 0 ? Math.round((variance / Math.abs(r.budget)) * 10000) / 100 : null };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/* ------------------------------------------------------------------ */
/* Audit log query — TASK 7                                            */
/* ------------------------------------------------------------------ */

export interface AuditFilters {
  entityType?: string;
  entityId?: number;
  userId?: number;
  action?: string;
  q?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export function queryAuditLog(orgId: number, f: AuditFilters): { rows: unknown[]; total: number } {
  const where: string[] = ["al.org_id = ?"];
  const params: unknown[] = [orgId];
  if (f.entityType) { where.push("al.entity_type = ?"); params.push(f.entityType); }
  if (f.entityId !== undefined) { where.push("al.entity_id = ?"); params.push(f.entityId); }
  if (f.userId !== undefined) { where.push("al.user_id = ?"); params.push(f.userId); }
  if (f.action) { where.push("al.action = ?"); params.push(f.action); }
  if (f.q) {
    // Free-text against summary; escape LIKE wildcards so "%"/"_" match literally.
    const escaped = f.q.replace(/([\\%_])/g, "\\$1");
    where.push("al.summary LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  if (f.from) { where.push("al.created_at >= ?"); params.push(`${f.from} 00:00:00`); }
  if (f.to) { where.push("al.created_at <= ?"); params.push(`${f.to} 23:59:59`); }
  const whereSql = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log al WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT al.*, u.email AS user_email FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ${whereSql} ORDER BY al.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize);
  return { rows, total };
}
