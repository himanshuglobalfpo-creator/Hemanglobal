/**
 * TASK 5 tests — importer dry-run, dedup, invoice grouping, opening balances.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestOrg, createCustomer, accountId, glBalance, db, storage } from "./setup.js";
import { importCustomers, importChartOfAccounts, importInvoices, importOpeningBalances } from "../server/importers.js";

function customerCsv(count: number, dupes: string[]): string {
  const rows = ["name,email,phone"];
  for (let i = 1; i <= count; i++) rows.push(`Customer ${i},c${i}@x.com,555-${i}`);
  for (const d of dupes) rows.push(`${d},dupe@x.com,`);
  return rows.join("\n");
}

test("acceptance: 500 customers with 3 dupes → inserted 497, skipped 3... plus 3 in-file dupes", () => {
  const { orgId, userId } = createTestOrg();
  // 3 pre-existing customers, case-different to prove case-insensitive dedup.
  createCustomer(orgId, "CUSTOMER 1");
  createCustomer(orgId, "customer 2");
  createCustomer(orgId, "Customer 3");
  const result = importCustomers(orgId, userId, customerCsv(500, []), false);
  assert.equal(result.inserted, 497);
  assert.equal(result.skipped, 3);
  assert.equal(result.errors.length, 0);
});

test("dry-run reports but writes nothing", () => {
  const { orgId, userId } = createTestOrg();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM customers WHERE org_id = ?").get(orgId) as { n: number }).n;
  const result = importCustomers(orgId, userId, customerCsv(10, ["Customer 5"]), true);
  assert.equal(result.dryRun, true);
  assert.equal(result.inserted, 10);
  assert.equal(result.skipped, 1); // in-file duplicate detected during the (rolled back) run
  const after = (db.prepare("SELECT COUNT(*) AS n FROM customers WHERE org_id = ?").get(orgId) as { n: number }).n;
  assert.equal(after, before); // rolled back
});

test("chart-of-accounts import validates type/subtype and skips existing codes", () => {
  const { orgId, userId } = createTestOrg();
  const csv = [
    "code,name,type,subtype",
    "1000,Duplicate Bank,asset,bank", // exists from seed → skipped
    "1200,Inventory,asset,current_asset",
    "9999,Bad Type,junk,bank",
    "8100,Bad Subtype,expense,not_a_subtype",
  ].join("\n");
  const result = importChartOfAccounts(orgId, userId, csv, false);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].message, /invalid type/);
  assert.match(result.errors[1].message, /invalid subtype/);
});

test("invoice import groups flat rows by number; unresolved names reject whole file unless partial", () => {
  const { orgId, userId } = createTestOrg();
  createCustomer(orgId, "Acme Inc");
  const csv = [
    "number,customer_name,date,due_date,line_description,quantity,rate,income_account_code,tax_rate",
    "IMP-1,Acme Inc,2026-01-05,2026-02-05,Design,2,100.00,4000,0",
    "IMP-1,Acme Inc,2026-01-05,2026-02-05,Development,10,150.00,4000,0",
    "IMP-2,Ghost Corp,2026-01-06,2026-02-06,Mystery,1,50.00,4000,0",
  ].join("\n");

  // Strict mode: one bad group rejects the whole file.
  const strict = importInvoices(orgId, userId, csv, false, false);
  assert.equal(strict.inserted, 0);
  assert.equal(strict.errors.length, 1);
  assert.match(strict.errors[0].message, /Ghost Corp/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE org_id = ?").get(orgId) as { n: number }).n, 0);

  // Partial mode: good group lands, bad group reported.
  const partial = importInvoices(orgId, userId, csv, false, true);
  assert.equal(partial.inserted, 1);
  assert.equal(partial.errors.length, 1);
  const inv = db.prepare("SELECT * FROM invoices WHERE org_id = ? AND number = 'IMP-1'").get(orgId) as { id: number; total: number };
  assert.ok(inv);
  assert.equal(inv.total, 2 * 10000 + 10 * 15000); // $200 + $1500 in cents
  const lines = db.prepare("SELECT COUNT(*) AS n FROM invoice_lines WHERE org_id = ? AND invoice_id = ?").get(orgId, inv.id) as { n: number };
  assert.equal(lines.n, 2); // grouped into one multi-line invoice
});

test("opening balances: unbalanced file rejected with the exact difference", () => {
  const { orgId, userId } = createTestOrg();
  const bad = ["account_code,debit,credit", "1000,100.00,", "3000,,90.00"].join("\n");
  const result = importOpeningBalances(orgId, userId, bad, "2026-01-01", false);
  assert.equal(result.inserted, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /difference 10\.00/);
});

test("opening balances: balanced file posts exactly ONE journal entry", () => {
  const { orgId, userId } = createTestOrg();
  const csv = ["account_code,debit,credit", "1000,2500.00,", "1100,500.00,", "3000,,3000.00"].join("\n");
  const result = importOpeningBalances(orgId, userId, csv, "2026-01-01", false);
  assert.equal(result.errors.length, 0);
  assert.equal(result.inserted, 3);
  const jes = db
    .prepare("SELECT * FROM journal_entries WHERE org_id = ? AND source = 'opening_balance'")
    .all(orgId) as Array<{ id: number; date: string }>;
  assert.equal(jes.length, 1);
  assert.equal(jes[0].date, "2026-01-01");
  assert.equal(glBalance(orgId, "1000"), 250000);
  assert.equal(glBalance(orgId, "3000"), -300000);
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});

test("strict import: bad calendar date (2026-13-40) yields a row-level error, not a raw ZodError", () => {
  const { orgId, userId } = createTestOrg();
  createCustomer(orgId, "Date Co");
  const csv = [
    "number,customer_name,date,due_date,line_description,quantity,rate,income_account_code,tax_rate",
    "IMP-D1,Date Co,2026-13-40,2026-02-05,Widget,1,10.00,4000,0",
  ].join("\n");
  const result = importInvoices(orgId, userId, csv, false, false);
  assert.equal(result.inserted, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 2); // structured {row, message} report
  assert.match(result.errors[0].message, /IMP-D1/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE org_id = ?").get(orgId) as { n: number }).n, 0);
});

test("trial balance as-of lists accounts with only post-cutoff activity at zero", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Late Co");
  storage.createInvoice(orgId, userId, {
    customerId,
    date: "2026-06-01",
    dueDate: "2026-07-01",
    lines: [{ description: "later", quantity: 1, rate: 1000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  const tb = storage.trialBalance(orgId, "2026-03-31");
  const sales = tb.find((r) => r.code === "4000");
  assert.ok(sales, "account must still appear in the as-of report");
  assert.equal(sales!.debit, 0);
  assert.equal(sales!.credit, 0);
  // Without a cutoff the activity shows.
  const tbAll = storage.trialBalance(orgId);
  assert.equal(tbAll.find((r) => r.code === "4000")!.credit, 1000);
});

test("RFC 4180: descriptions with commas and quotes survive import", () => {
  const { orgId, userId } = createTestOrg();
  createCustomer(orgId, "Punct & Co");
  const csv = [
    "number,customer_name,date,due_date,line_description,quantity,rate,income_account_code,tax_rate",
    `IMP-Q,"Punct & Co",2026-01-05,2026-02-05,"Design, ""special"" edition",1,100.00,4000,0`,
  ].join("\n");
  const result = importInvoices(orgId, userId, csv, false, false);
  assert.equal(result.inserted, 1);
  const line = db
    .prepare("SELECT il.description FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE i.org_id = ? AND i.number = 'IMP-Q'")
    .get(orgId) as { description: string };
  assert.equal(line.description, 'Design, "special" edition');
});
