/**
 * tests/setup.ts — shared test bootstrap.
 * Sets test env BEFORE the db module is evaluated (dynamic import + TLA),
 * so the database is in-memory and migrations run against it.
 */
process.env.NODE_ENV = "test";
process.env.VAULT_KEY = "test-vault-key";

const dbModule = await import("../server/db.js");
dbModule.runMigrations();

export const db = dbModule.db;
export const storage = await import("../server/storage.js");

let seq = 0;

export function createTestOrg(baseCurrency = "USD"): { orgId: number; userId: number } {
  seq++;
  const org = db.prepare("INSERT INTO orgs (name, base_currency) VALUES (?,?)").run(`Test Org ${seq}`, baseCurrency);
  const user = db
    .prepare("INSERT INTO users (email, password_hash, name) VALUES (?,?,?)")
    .run(`owner${seq}@test.local`, "x", `Owner ${seq}`);
  const orgId = Number(org.lastInsertRowid);
  const userId = Number(user.lastInsertRowid);
  db.prepare("INSERT INTO org_users (org_id, user_id, role) VALUES (?,?,'owner')").run(orgId, userId);
  storage.seedChartOfAccounts(orgId);
  return { orgId, userId };
}

export function createCustomer(orgId: number, name: string, currency?: string): number {
  const r = db.prepare("INSERT INTO customers (org_id, name, currency) VALUES (?,?,?)").run(orgId, name, currency ?? null);
  return Number(r.lastInsertRowid);
}

export function createVendor(orgId: number, name: string, currency?: string): number {
  const r = db.prepare("INSERT INTO vendors (org_id, name, currency) VALUES (?,?,?)").run(orgId, name, currency ?? null);
  return Number(r.lastInsertRowid);
}

export function accountId(orgId: number, code: string): number {
  return storage.accountByCode(orgId, code).id;
}

/** Net GL balance (debit-positive) of one account in base cents. */
export function glBalance(orgId: number, code: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS bal
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.org_id = ? AND a.code = ?`,
    )
    .get(orgId, code) as { bal: number };
  return row.bal;
}
