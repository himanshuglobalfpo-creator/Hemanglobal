// ============================================================================
// DATA IMPORT — CSV-first migration path
// ============================================================================
// Five importers (customers, vendors, chart of accounts, invoices, opening
// balances). Contracts shared by all:
//   - ?dryRun=true → full validation, ZERO writes, same report shape.
//   - Response: { inserted, skipped, errors: [{ row, message }] }.
//   - One transaction per file. Invoice import with ?partial=true wraps each
//     invoice group in a nested transaction (PostgreSQL savepoint via
//     drizzle's tx.transaction) so one bad group doesn't sink the file.
//   - Row numbers in errors are 1-based DATA rows (header = row 0).
// Parsing: csv-parse/sync (already a dependency).

import { parse } from "csv-parse/sync";
import { db, pool, storage } from "./storage";
import { currentOrgId } from "./org-scope";
import { toCents } from "@shared/money";
import { ACCOUNT_TYPES, ACCOUNT_SUBTYPES } from "@shared/schema";

export type ImportReport = {
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  dryRun: boolean;
};

function parseCsv(csvText: string): Record<string, string>[] {
  return parse(csvText, {
    columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];
}

// ---------------------------------------------------------------------------
// 5a/5b — customers & vendors (same pattern, parameterized)
// ---------------------------------------------------------------------------
async function importParties(
  table: "customers" | "vendors",
  csvText: string,
  dryRun: boolean
): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  const report: ImportReport = { inserted: 0, skipped: 0, errors: [], dryRun };
  const orgId = currentOrgId();

  // Case-insensitive dedup set: existing names in the org + names seen in file.
  const existing = new Set(
    ((await pool.query(`SELECT lower(name) AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows as any[]).map((r) => r.n)
  );

  type Row = { name: string; email: string | null; phone: string | null; address: string | null; shipping_city: string | null; shipping_state: string | null; shipping_zip: string | null };
  const toInsert: Row[] = [];
  rows.forEach((r, i) => {
    const rowNum = i + 1;
    const name = (r.name || "").trim();
    if (!name) {
      report.errors.push({ row: rowNum, message: "name is required" });
      return;
    }
    if (existing.has(name.toLowerCase())) {
      report.skipped++; // dedup by case-insensitive name within org
      return;
    }
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
      report.errors.push({ row: rowNum, message: `invalid email "${r.email}"` });
      return;
    }
    existing.add(name.toLowerCase()); // dedup within the file too
    toInsert.push({
      name,
      email: r.email || null,
      phone: r.phone || null,
      address: r.address || null,
      shipping_city: r.shipping_city || null,
      shipping_state: r.shipping_state || null,
      shipping_zip: r.shipping_zip || null,
    });
  });

  if (report.errors.length > 0 || dryRun) {
    report.inserted = toInsert.length; // what WOULD be inserted
    return report;
  }

  await db.transaction(async () => {
    for (const p of toInsert) {
      await pool.query(
        `INSERT INTO ${table} (org_id, name, email, phone, address, shipping_city, shipping_state, shipping_zip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orgId, p.name, p.email, p.phone, p.address, p.shipping_city, p.shipping_state, p.shipping_zip]
      );
      report.inserted++;
    }
  });
  await storage.audit("import", table === "customers" ? "customer" : "vendor", null,
    `CSV import: ${report.inserted} inserted, ${report.skipped} skipped (duplicates)`);
  return report;
}

export const importCustomers = (csv: string, dryRun: boolean) => importParties("customers", csv, dryRun);
export const importVendors = (csv: string, dryRun: boolean) => importParties("vendors", csv, dryRun);

// ---------------------------------------------------------------------------
// 5c — chart of accounts
// ---------------------------------------------------------------------------
export async function importChartOfAccounts(csvText: string, dryRun: boolean): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  const report: ImportReport = { inserted: 0, skipped: 0, errors: [], dryRun };
  const orgId = currentOrgId();
  const existingCodes = new Set(
    ((await pool.query(`SELECT code FROM accounts WHERE org_id = $1`, [orgId])).rows as any[]).map((r) => r.code)
  );
  const types = new Set(ACCOUNT_TYPES as readonly string[]);
  // ACCOUNT_SUBTYPES is a map { type: readonly subtype[] } — validate the
  // subtype against ITS declared type, not a flat pool.
  const subtypesFor = (t: string): Set<string> => new Set(((ACCOUNT_SUBTYPES as any)[t] ?? []) as string[]);

  const toInsert: Array<{ code: string; name: string; type: string; subtype: string | null }> = [];
  rows.forEach((r, i) => {
    const rowNum = i + 1;
    const code = (r.code || "").trim();
    const name = (r.name || "").trim();
    const type = (r.type || "").trim().toLowerCase();
    const subtype = (r.subtype || "").trim().toLowerCase() || null;
    if (!code || !name || !type) {
      report.errors.push({ row: rowNum, message: "code, name and type are required" });
      return;
    }
    if (!types.has(type)) {
      report.errors.push({ row: rowNum, message: `invalid type "${type}" (allowed: ${[...types].join(", ")})` });
      return;
    }
    if (subtype && !subtypesFor(type).has(subtype)) {
      report.errors.push({ row: rowNum, message: `invalid subtype "${subtype}" for type "${type}"` });
      return;
    }
    if (existingCodes.has(code)) {
      report.skipped++; // skip existing codes
      return;
    }
    existingCodes.add(code);
    toInsert.push({ code, name, type, subtype });
  });

  if (report.errors.length > 0 || dryRun) {
    report.inserted = toInsert.length;
    return report;
  }
  await db.transaction(async () => {
    for (const a of toInsert) {
      await pool.query(
        `INSERT INTO accounts (org_id, code, name, type, subtype, is_active) VALUES ($1,$2,$3,$4,$5,true)`,
        [orgId, a.code, a.name, a.type, a.subtype]
      );
      report.inserted++;
    }
  });
  await storage.audit("import", "account", null, `CSV import: ${report.inserted} accounts inserted, ${report.skipped} skipped`);
  return report;
}

// ---------------------------------------------------------------------------
// 5d — invoices (flat rows grouped by number)
// ---------------------------------------------------------------------------
export async function importInvoices(csvText: string, dryRun: boolean, partial: boolean): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  const report: ImportReport = { inserted: 0, skipped: 0, errors: [], dryRun };
  const orgId = currentOrgId();

  const customers = (await pool.query(`SELECT id, lower(name) AS name FROM customers WHERE org_id = $1`, [orgId])).rows as any[];
  const custByName = new Map(customers.map((c) => [c.name, c.id]));
  const accounts = (await pool.query(`SELECT id, code FROM accounts WHERE org_id = $1`, [orgId])).rows as any[];
  const acctByCode = new Map(accounts.map((a) => [a.code, a.id]));
  const existingNumbers = new Set(
    ((await pool.query(`SELECT number FROM invoices WHERE org_id = $1`, [orgId])).rows as any[]).map((r) => r.number)
  );

  // Group flat rows by invoice number, preserving row numbers for errors.
  type Group = { number: string; rows: Array<{ rowNum: number; r: Record<string, string> }> };
  const groups = new Map<string, Group>();
  rows.forEach((r, i) => {
    const number = (r.number || "").trim();
    if (!number) {
      report.errors.push({ row: i + 1, message: "number is required" });
      return;
    }
    if (!groups.has(number)) groups.set(number, { number, rows: [] });
    groups.get(number)!.rows.push({ rowNum: i + 1, r });
  });

  type Prepared = {
    number: string;
    customerId: number;
    date: string; dueDate: string; taxRate: number;
    lines: Array<{ description: string; quantity: number; rate: number; incomeAccountId: number }>;
  };
  const prepared: Prepared[] = [];

  for (const g of groups.values()) {
    if (existingNumbers.has(g.number)) {
      report.skipped++;
      continue;
    }
    const head = g.rows[0];
    const custName = (head.r.customer_name || "").trim().toLowerCase();
    const customerId = custByName.get(custName);
    const groupErrors: Array<{ row: number; message: string }> = [];
    if (!customerId) groupErrors.push({ row: head.rowNum, message: `unresolved customer_name "${head.r.customer_name}"` });
    const date = (head.r.date || "").trim();
    const dueDate = (head.r.due_date || date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) groupErrors.push({ row: head.rowNum, message: `invalid date "${date}" (YYYY-MM-DD)` });
    const taxRate = Number(head.r.tax_rate || 0);
    if (!(taxRate >= 0 && taxRate <= 100)) groupErrors.push({ row: head.rowNum, message: `invalid tax_rate "${head.r.tax_rate}"` });

    const lines: Prepared["lines"] = [];
    for (const { rowNum, r } of g.rows) {
      const qty = Number(r.quantity);
      const rate = Number(r.rate);
      const acctId = acctByCode.get((r.income_account_code || "").trim());
      if (!r.line_description) groupErrors.push({ row: rowNum, message: "line_description is required" });
      if (!(qty > 0)) groupErrors.push({ row: rowNum, message: `invalid quantity "${r.quantity}"` });
      if (!Number.isFinite(rate)) groupErrors.push({ row: rowNum, message: `invalid rate "${r.rate}"` });
      if (!acctId) groupErrors.push({ row: rowNum, message: `unresolved income_account_code "${r.income_account_code}"` });
      if (acctId) lines.push({ description: r.line_description, quantity: qty, rate, incomeAccountId: acctId });
    }
    if (groupErrors.length > 0) {
      report.errors.push(...groupErrors);
      continue;
    }
    prepared.push({ number: g.number, customerId: customerId!, date, dueDate, taxRate, lines });
  }

  // Whole file rejected on any error unless ?partial=true.
  if ((report.errors.length > 0 && !partial) || dryRun) {
    report.inserted = prepared.length;
    return report;
  }

  // partial=true → per-group savepoint (nested transaction) so a surprise
  // runtime failure in one group (e.g. a period lock) doesn't sink the rest.
  await db.transaction(async (tx) => {
    for (const p of prepared) {
      try {
        await tx.transaction(async () => {
          await storage.createInvoice({
            number: p.number,
            customerId: p.customerId,
            date: p.date,
            dueDate: p.dueDate,
            taxRate: p.taxRate,
            lines: p.lines,
          } as any);
        });
        report.inserted++;
      } catch (e: any) {
        if (!partial) throw e;
        report.errors.push({ row: 0, message: `invoice ${p.number}: ${e.message}` });
      }
    }
  });
  await storage.audit("import", "invoice", null,
    `CSV import: ${report.inserted} invoices inserted, ${report.skipped} skipped, ${report.errors.length} errors`);
  return report;
}

// ---------------------------------------------------------------------------
// 5e — opening balances (one balanced JE)
// ---------------------------------------------------------------------------
export async function importOpeningBalances(csvText: string, asOfDate: string, dryRun: boolean): Promise<ImportReport> {
  const rows = parseCsv(csvText);
  const report: ImportReport = { inserted: 0, skipped: 0, errors: [], dryRun };
  const orgId = currentOrgId();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate || "")) {
    report.errors.push({ row: 0, message: "asOfDate (YYYY-MM-DD) is required in the request body" });
    return report;
  }
  const accounts = (await pool.query(`SELECT id, code FROM accounts WHERE org_id = $1`, [orgId])).rows as any[];
  const acctByCode = new Map(accounts.map((a) => [a.code, a.id]));

  const jeLines: Array<{ accountId: number; debit: number; credit: number; description: string }> = [];
  let totalDr = 0;
  let totalCr = 0;
  rows.forEach((r, i) => {
    const rowNum = i + 1;
    const acctId = acctByCode.get((r.account_code || "").trim());
    if (!acctId) {
      report.errors.push({ row: rowNum, message: `unresolved account_code "${r.account_code}"` });
      return;
    }
    // Dollars in the file → integer cents ONCE at this boundary.
    const debit = r.debit ? toCents(Number(r.debit)) : 0;
    const credit = r.credit ? toCents(Number(r.credit)) : 0;
    if (debit < 0 || credit < 0 || (debit > 0 && credit > 0)) {
      report.errors.push({ row: rowNum, message: "each row needs debit OR credit (non-negative, not both)" });
      return;
    }
    if (debit === 0 && credit === 0) return; // blank row — ignore
    totalDr += debit;
    totalCr += credit;
    jeLines.push({ accountId: acctId, debit, credit, description: "Opening balance" });
  });

  if (totalDr !== totalCr) {
    const diff = totalDr - totalCr;
    report.errors.push({
      row: 0,
      message: `Opening balances do not balance: debits ${(totalDr / 100).toFixed(2)} vs credits ${(totalCr / 100).toFixed(2)} — difference ${(diff / 100).toFixed(2)} (debits ${diff > 0 ? "exceed" : "fall short of"} credits).`,
    });
  }
  if (jeLines.length < 2) {
    report.errors.push({ row: 0, message: "at least two non-zero rows are required" });
  }
  if (report.errors.length > 0 || dryRun) {
    report.inserted = report.errors.length === 0 ? 1 : 0; // one JE would be posted
    return report;
  }

  await storage.postJournalEntry({
    date: asOfDate,
    memo: "Opening balances (imported)",
    reference: "OPENING",
    source: "opening_balance",
    lines: jeLines,
  } as any);
  report.inserted = 1;
  await storage.audit("import", "journal_entry", null,
    `Opening balances imported as of ${asOfDate}: ${jeLines.length} lines, ${(totalDr / 100).toFixed(2)} each side`);
  return report;
}
