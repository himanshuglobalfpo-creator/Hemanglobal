/**
 * scripts/seed-demo.ts — idempotent demo-data seeder (npm run seed).
 * Creates a demo org with realistic activity so QA/demo environments have
 * something to look at: customers (one EUR), vendors, FX rates, invoices
 * (domestic, foreign, partially paid), a bill, a credit note, and a budget.
 *
 * Login: demo@ledgerlite.app / demo1234  (MFA not enabled — grace period)
 * Safe to run repeatedly: exits early if the demo user already exists.
 */
import bcrypt from "bcryptjs";
import { db, runMigrations } from "../server/db.js";
import {
  seedChartOfAccounts, accountByCode, upsertFxRate,
  createInvoice, createBill, createCreditNote, payInvoice, payBill, audit,
} from "../server/storage.js";

runMigrations();

const DEMO_EMAIL = "demo@ledgerlite.app";

if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(DEMO_EMAIL)) {
  console.log(`demo user ${DEMO_EMAIL} already exists — nothing to do`);
  process.exit(0);
}

const seed = db.transaction((): { orgId: number; userId: number } => {
  const user = db
    .prepare("INSERT INTO users (email, password_hash, name) VALUES (?,?,?)")
    .run(DEMO_EMAIL, bcrypt.hashSync("demo1234", 10), "Demo Owner");
  const org = db.prepare("INSERT INTO orgs (name, base_currency) VALUES (?,?)").run("Demo Company Inc", "USD");
  const orgId = Number(org.lastInsertRowid);
  const userId = Number(user.lastInsertRowid);
  db.prepare("INSERT INTO org_users (org_id, user_id, role) VALUES (?,?,'owner')").run(orgId, userId);
  seedChartOfAccounts(orgId);
  audit(orgId, userId, "create", "org", orgId, "Demo org seeded");
  return { orgId, userId };
});
const { orgId, userId } = seed();

const party = (table: "customers" | "vendors", name: string, email: string, currency?: string): number =>
  Number(
    db.prepare(`INSERT INTO ${table} (org_id, name, email, currency) VALUES (?,?,?,?)`)
      .run(orgId, name, email, currency ?? null).lastInsertRowid,
  );

const acme = party("customers", "Acme Industries", "billing@acme.example");
const euro = party("customers", "Berlin Software GmbH", "ap@berlinsoft.example", "EUR");
party("customers", "Northwind Traders", "accounts@northwind.example");
const paperCo = party("vendors", "Paper Supply Co", "orders@papersupply.example");
party("vendors", "Cloud Hosting LLC", "billing@cloudhosting.example");

const today = new Date();
const iso = (daysAgo: number): string => new Date(today.getTime() - daysAgo * 864e5).toISOString().slice(0, 10);

upsertFxRate(orgId, iso(30), "EUR", "USD", 1.09, "demo");
upsertFxRate(orgId, iso(1), "EUR", "USD", 1.11, "demo");

const sales = accountByCode(orgId, "4000").id;
const expense = accountByCode(orgId, "6000").id;
const bank = accountByCode(orgId, "1000").id;

// Domestic invoice, fully paid.
const inv1 = createInvoice(orgId, userId, {
  customerId: acme, date: iso(25), dueDate: iso(-5),
  lines: [
    { description: "Consulting retainer", quantity: 10, rate: 15000, accountId: sales, taxRate: 8.5 },
    { description: "Onsite workshop", quantity: 1, rate: 250000, accountId: sales, taxRate: 8.5 },
  ],
});
payInvoice(orgId, userId, inv1.id, { date: iso(10), amount: inv1.total, bankAccountId: bank });

// EUR invoice at 1.10, partially paid at 1.08 → realized FX loss on the books.
const inv2 = createInvoice(orgId, userId, {
  customerId: euro, date: iso(20), dueDate: iso(-10), currency: "EUR", fxRate: 1.1,
  lines: [{ description: "Software licence (annual)", quantity: 1, rate: 500000, accountId: sales, taxRate: 0 }],
});
payInvoice(orgId, userId, inv2.id, { date: iso(5), foreignAmount: 250000, fxRate: 1.08, bankAccountId: bank });

// Open domestic invoice (shows up in A/R and sales-by-customer balances).
createInvoice(orgId, userId, {
  customerId: acme, date: iso(3), dueDate: iso(-27),
  lines: [{ description: "Support hours", quantity: 8, rate: 12500, accountId: sales, taxRate: 0 }],
});

// Vendor bill, paid.
const bill1 = createBill(orgId, userId, {
  vendorId: paperCo, date: iso(15), dueDate: iso(-15),
  lines: [{ description: "Office supplies", quantity: 1, rate: 42000, accountId: expense, taxRate: 0 }],
});
payBill(orgId, userId, bill1.id, { date: iso(7), amount: bill1.total, bankAccountId: bank });

// Credit note against the first customer.
createCreditNote(orgId, userId, {
  customerId: acme, invoiceId: inv1.id, date: iso(8),
  lines: [{ description: "Goodwill credit — workshop overrun", quantity: 1, rate: 25000, accountId: sales, taxRate: 0 }],
});

// Current-year budget for sales and expenses.
const budgetId = Number(
  db.prepare("INSERT INTO budgets (org_id, name, fiscal_year) VALUES (?,?,?)")
    .run(orgId, `FY${today.getFullYear()} Operating Plan`, today.getFullYear()).lastInsertRowid,
);
const insBl = db.prepare("INSERT INTO budget_lines (org_id, budget_id, account_id, month, amount) VALUES (?,?,?,?,?)");
for (let m = 1; m <= 12; m++) {
  insBl.run(orgId, budgetId, sales, m, 500000); // $5,000/mo income target
  insBl.run(orgId, budgetId, expense, m, 120000); // $1,200/mo expense budget
}

audit(orgId, userId, "import", "org", orgId, "Demo dataset seeded");
console.log(`demo org seeded (org ${orgId}) — login ${DEMO_EMAIL} / demo1234`);
