/**
 * server/importers.ts — TASK 5: CSV-first data import.
 * - csv-parse (sync API) does the parsing; every importer runs inside ONE
 *   transaction per file. dryRun=true executes the full import then rolls
 *   the transaction back, so the validation report is exactly what a real
 *   run would do.
 * - partial=true (invoices) wraps each invoice group in a nested
 *   db.transaction — better-sqlite3 implements nested transactions as
 *   SAVEPOINTs, so one bad group rolls back alone.
 * - Every importer returns { inserted, skipped, errors:[{row,message}] }
 *   and writes one audit summary entry (real runs only).
 */
import { parse } from "csv-parse/sync";
import { db } from "./db.js";
import { ACCOUNT_TYPES, ACCOUNT_SUBTYPES, type ImportResult, type ImportRowError } from "../shared/schema.js";
import { dollarsToCents } from "../shared/money.js";
import { accountByCode, audit, createInvoice, postJournalEntry, assertPeriodOpen, HttpError } from "./storage.js";

class DryRunRollback extends Error {}

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  return parse(text, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as CsvRow[];
}

/** Data rows start at line 2 (line 1 is the header). */
const rowNum = (index: number): number => index + 2;

function runFileTransaction(work: () => void, dryRun: boolean): void {
  const tx = db.transaction(() => {
    work();
    if (dryRun) throw new DryRunRollback();
  });
  try {
    tx();
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
}

/* --------------------- 5a/5b: customers & vendors ------------------ */

function importParties(table: "customers" | "vendors", orgId: number, userId: number, csvText: string, dryRun: boolean): ImportResult {
  const rows = parseCsv(csvText);
  const errors: ImportRowError[] = [];
  let inserted = 0;
  let skipped = 0;

  runFileTransaction(() => {
    const existsStmt = db.prepare(`SELECT 1 FROM ${table} WHERE org_id = ? AND lower(name) = lower(?)`);
    const insertStmt = db.prepare(
      `INSERT INTO ${table} (org_id, name, email, phone, address, shipping_city, shipping_state, shipping_zip)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const seenInFile = new Set<string>();
    rows.forEach((r, i) => {
      const name = (r.name ?? "").trim();
      if (!name) {
        errors.push({ row: rowNum(i), message: "name is required" });
        return;
      }
      const key = name.toLowerCase();
      // Dedup case-insensitively against the org AND earlier rows in this file.
      if (seenInFile.has(key) || existsStmt.get(orgId, name)) {
        skipped++;
        return;
      }
      seenInFile.add(key);
      insertStmt.run(orgId, name, r.email || null, r.phone || null, r.address || null, r.shipping_city || null, r.shipping_state || null, r.shipping_zip || null);
      inserted++;
    });
    if (!dryRun) audit(orgId, userId, "import", table === "customers" ? "customer" : "vendor", null, `CSV import: ${inserted} inserted, ${skipped} skipped, ${errors.length} errors`);
  }, dryRun);

  return { inserted, skipped, errors, dryRun };
}

export const importCustomers = (orgId: number, userId: number, csv: string, dryRun: boolean): ImportResult =>
  importParties("customers", orgId, userId, csv, dryRun);
export const importVendors = (orgId: number, userId: number, csv: string, dryRun: boolean): ImportResult =>
  importParties("vendors", orgId, userId, csv, dryRun);

/* --------------------- 5c: chart of accounts ----------------------- */

export function importChartOfAccounts(orgId: number, userId: number, csvText: string, dryRun: boolean): ImportResult {
  const rows = parseCsv(csvText);
  const errors: ImportRowError[] = [];
  let inserted = 0;
  let skipped = 0;

  runFileTransaction(() => {
    const existsStmt = db.prepare("SELECT 1 FROM accounts WHERE org_id = ? AND code = ?");
    const insertStmt = db.prepare("INSERT INTO accounts (org_id, code, name, type, subtype) VALUES (?,?,?,?,?)");
    rows.forEach((r, i) => {
      const code = (r.code ?? "").trim();
      const name = (r.name ?? "").trim();
      const type = (r.type ?? "").trim().toLowerCase();
      const subtype = (r.subtype ?? "").trim().toLowerCase();
      if (!/^\d{4}$/.test(code)) return void errors.push({ row: rowNum(i), message: `invalid account code "${code}" (4 digits required)` });
      if (!name) return void errors.push({ row: rowNum(i), message: "name is required" });
      if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
        return void errors.push({ row: rowNum(i), message: `invalid type "${type}" (expected one of ${ACCOUNT_TYPES.join(", ")})` });
      }
      if (!(ACCOUNT_SUBTYPES as readonly string[]).includes(subtype)) {
        return void errors.push({ row: rowNum(i), message: `invalid subtype "${subtype}"` });
      }
      if (existsStmt.get(orgId, code)) {
        skipped++;
        return;
      }
      insertStmt.run(orgId, code, name, type, subtype);
      inserted++;
    });
    if (!dryRun) audit(orgId, userId, "import", "account", null, `COA import: ${inserted} inserted, ${skipped} skipped, ${errors.length} errors`);
  }, dryRun);

  return { inserted, skipped, errors, dryRun };
}

/* --------------------- 5d: invoices -------------------------------- */

interface InvoiceGroup {
  number: string;
  firstRow: number;
  customerName: string;
  date: string;
  dueDate: string;
  lines: Array<{ description: string; quantity: number; rate: number; accountCode: string; taxRate: number }>;
}

export function importInvoices(orgId: number, userId: number, csvText: string, dryRun: boolean, partial: boolean): ImportResult {
  const rows = parseCsv(csvText);
  const errors: ImportRowError[] = [];
  const groups = new Map<string, InvoiceGroup>();

  rows.forEach((r, i) => {
    const number = (r.number ?? "").trim();
    if (!number) return void errors.push({ row: rowNum(i), message: "number is required" });
    let g = groups.get(number);
    if (!g) {
      g = {
        number,
        firstRow: rowNum(i),
        customerName: (r.customer_name ?? "").trim(),
        date: (r.date ?? "").trim(),
        dueDate: (r.due_date ?? r.date ?? "").trim(),
        lines: [],
      };
      groups.set(number, g);
    }
    const quantity = Number(r.quantity ?? "1");
    const rate = r.rate !== undefined && r.rate !== "" ? dollarsSafe(r.rate) : NaN;
    if (!Number.isFinite(quantity) || quantity <= 0) return void errors.push({ row: rowNum(i), message: `invalid quantity "${r.quantity}"` });
    if (!Number.isFinite(rate)) return void errors.push({ row: rowNum(i), message: `invalid rate "${r.rate}"` });
    g.lines.push({
      description: (r.line_description ?? "").trim() || "Imported line",
      quantity,
      rate,
      accountCode: (r.income_account_code ?? "").trim(),
      taxRate: Number(r.tax_rate ?? "0") || 0,
    });
  });

  let inserted = 0;
  let skipped = 0;
  let rejected = false;

  const work = () => {
    const customerStmt = db.prepare("SELECT id FROM customers WHERE org_id = ? AND lower(name) = lower(?)");
    const accountStmt = db.prepare("SELECT id FROM accounts WHERE org_id = ? AND code = ?");
    const invoiceExists = db.prepare("SELECT 1 FROM invoices WHERE org_id = ? AND number = ?");

    for (const g of groups.values()) {
      const groupErrors: string[] = [];
      const customer = customerStmt.get(orgId, g.customerName) as { id: number } | undefined;
      if (!customer) groupErrors.push(`customer "${g.customerName}" not found`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(g.date)) groupErrors.push(`invalid date "${g.date}"`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(g.dueDate)) groupErrors.push(`invalid due_date "${g.dueDate}"`);
      const lineInputs = g.lines.map((l) => {
        const acct = accountStmt.get(orgId, l.accountCode) as { id: number } | undefined;
        if (!acct) groupErrors.push(`income_account_code "${l.accountCode}" not found`);
        return { description: l.description, quantity: l.quantity, rate: l.rate, accountId: acct?.id ?? 0, taxRate: l.taxRate };
      });
      if (invoiceExists.get(orgId, g.number)) {
        skipped++;
        continue;
      }
      if (groupErrors.length > 0) {
        errors.push({ row: g.firstRow, message: `invoice ${g.number}: ${groupErrors.join("; ")}` });
        continue;
      }
      const create = () =>
        createInvoice(orgId, userId, {
          customerId: customer!.id,
          date: g.date,
          dueDate: g.dueDate,
          number: g.number,
          lines: lineInputs,
        });
      if (partial) {
        // Nested db.transaction => SAVEPOINT: one bad invoice rolls back alone.
        try {
          db.transaction(create)();
          inserted++;
        } catch (err) {
          errors.push({ row: g.firstRow, message: `invoice ${g.number}: ${(err as Error).message}` });
        }
      } else {
        create();
        inserted++;
      }
    }

    // Whole-file rejection unless ?partial=true.
    if (!partial && errors.length > 0) {
      throw new HttpError(400, "import rejected: fix row errors or retry with ?partial=true");
    }
    if (!dryRun) audit(orgId, userId, "import", "invoice", null, `Invoice import: ${inserted} inserted, ${skipped} skipped, ${errors.length} errors`);
  };

  try {
    runFileTransaction(work, dryRun);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    rejected = true; // whole file rolled back; report the row errors
  }

  return { inserted: rejected ? 0 : inserted, skipped, errors, dryRun };
}

function dollarsSafe(v: string): number {
  try {
    return dollarsToCents(v);
  } catch {
    return NaN;
  }
}

/* --------------------- 5e: opening balances ------------------------ */

export function importOpeningBalances(orgId: number, userId: number, csvText: string, asOfDate: string, dryRun: boolean): ImportResult {
  const rows = parseCsv(csvText);
  const errors: ImportRowError[] = [];
  const lines: Array<{ accountId: number; debit: number; credit: number }> = [];
  let totalDr = 0;
  let totalCr = 0;

  rows.forEach((r, i) => {
    const code = (r.account_code ?? "").trim();
    let acctId: number;
    try {
      acctId = accountByCode(orgId, code).id;
    } catch {
      return void errors.push({ row: rowNum(i), message: `account_code "${code}" not found` });
    }
    const debit = r.debit ? dollarsSafe(r.debit) : 0;
    const credit = r.credit ? dollarsSafe(r.credit) : 0;
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) {
      return void errors.push({ row: rowNum(i), message: `invalid debit/credit on account ${code}` });
    }
    totalDr += debit;
    totalCr += credit;
    lines.push({ accountId: acctId, debit, credit });
  });

  if (totalDr !== totalCr) {
    errors.push({
      row: 0,
      message: `file does not balance: debits ${(totalDr / 100).toFixed(2)} != credits ${(totalCr / 100).toFixed(2)} (difference ${((totalDr - totalCr) / 100).toFixed(2)})`,
    });
  }
  if (errors.length > 0) return { inserted: 0, skipped: 0, errors, dryRun };

  assertPeriodOpen(orgId, asOfDate);
  runFileTransaction(() => {
    // Exactly ONE journal entry for the whole file.
    postJournalEntry(orgId, asOfDate, "Opening balances", "opening_balance", null, lines);
    if (!dryRun) audit(orgId, userId, "import", "journal_entry", null, `Opening balances as of ${asOfDate}: ${lines.length} lines`);
  }, dryRun);

  return { inserted: lines.length, skipped: 0, errors, dryRun };
}
