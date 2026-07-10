// ============================================================================
// BUG-002 REGRESSION — money columns are BIGINT (past the old int4 cap)
// ============================================================================
// Before the fix, money columns were 32-bit `integer`, capping any single
// amount at $21,474,836.47. This proves:
//
//   (1) The money columns are BIGINT after migration 0020.
//   (2) An invoice whose line amount EXCEEDS the old int4 cap ($30,000,000)
//       posts, its journal entry balances, and every value reads back EXACTLY
//       (no overflow / truncation).
//   (3) toCents() enforces a configurable upper bound.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/bigint_money_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toCents, MAX_TX_CENTS } from "../shared/money";
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
function expectThrow(label: string, fn: () => unknown, pattern: RegExp) {
  try { fn(); failures++; console.error(`  ✗ ${label} — expected an error, none thrown`); }
  catch (e: any) { check(label, pattern.test(String(e?.message)), `got: ${e?.message}`); }
}

const INT4_MAX_CENTS = 2_147_483_647; // old cap ($21,474,836.47)

async function main() {
  // ------------------------------------------------------------------------
  console.log("[1] toCents() upper-bound guard");
  // ------------------------------------------------------------------------
  check("toCents accepts a normal amount", toCents(1234.56) === 123456);
  check("toCents accepts a value just under the max", toCents(MAX_TX_CENTS / 100) === MAX_TX_CENTS);
  expectThrow("toCents rejects an amount above the max", () => toCents(MAX_TX_CENTS / 100 + 1), /exceeds the maximum/i);
  expectThrow("toCents rejects a custom lower max", () => toCents(1000, 50_000), /exceeds the maximum/i);

  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("bigint_money");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Bigint Co', 'bigint-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('b@b.test', 'x', 'Bigint Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    // ------------------------------------------------------------------------
    console.log("\n[2] Money columns are BIGINT after migration 0020");
    // ------------------------------------------------------------------------
    const cols = (await pool.query(`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE (table_name, column_name) IN (
        ('invoices','total'), ('invoice_lines','amount'), ('journal_lines','debit'), ('journal_lines','credit'),
        ('bills','total'), ('payroll_items','gross_cents'), ('fixed_assets','cost_cents'), ('budget_lines','amount')
      ) ORDER BY table_name, column_name`)).rows as Array<{ table_name: string; column_name: string; data_type: string }>;
    check("sampled money columns are all bigint", cols.length >= 8 && cols.every((c) => c.data_type === "bigint"),
      cols.map((c) => `${c.table_name}.${c.column_name}=${c.data_type}`).join(", "));

    // ------------------------------------------------------------------------
    console.log("\n[3] A $30,000,000 invoice (beyond the old int4 cap) posts and reads back exactly");
    // ------------------------------------------------------------------------
    const accts = await run(() => storage.listAccounts());
    const sales = accts.find((a) => a.code === "4000")!;
    const arId = accts.find((a) => a.code === "1100")!.id;
    const customerId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Whale Corp') RETURNING id`)).rows[0].id as number;

    const bigCents = 3_000_000_000; // $30,000,000.00 — well past int4 max (2,147,483,647)
    check("the amount exceeds the old int4 cap", bigCents > INT4_MAX_CENTS);
    const inv = await run(() => storage.createInvoice({
      customerId, date: "2026-01-10", dueDate: "2026-02-10", taxRate: 0,
      lines: [{ description: "Enterprise deal", quantity: 1, rate: 30_000_000, incomeAccountId: sales.id }],
    } as any));
    check("invoice total stored exactly = $30,000,000 (3,000,000,000¢)", inv.total === bigCents, String(inv.total));

    // Read back through Drizzle and raw SQL — both must be the exact number, not truncated/stringified.
    const fetched = (await run(() => storage.getInvoice(inv.id)))!;
    check("Drizzle read-back total is exact", fetched.total === bigCents, String(fetched.total));
    const raw = (await pool.query(`SELECT total, subtotal FROM invoices WHERE id = $1`, [inv.id])).rows[0];
    check("raw SQL read-back total is an exact number (bigint parsed to number)", raw.total === bigCents && typeof raw.total === "number", `${raw.total} (${typeof raw.total})`);

    // The journal entry balances at this magnitude (Dr A/R 3e9 / Cr Sales 3e9).
    const je = (await pool.query(
      `SELECT jl.debit, jl.credit, jl.account_id AS "accountId" FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id WHERE je.org_id = 1 AND je.source = 'invoice' AND je.source_id = $1`, [inv.id]
    )).rows as Array<{ debit: number; credit: number; accountId: number }>;
    const dr = je.reduce((s, r) => s + Number(r.debit), 0);
    const cr = je.reduce((s, r) => s + Number(r.credit), 0);
    check("journal entry balances at $30M (Dr = Cr = 3,000,000,000)", dr === bigCents && cr === bigCents, `dr ${dr} cr ${cr}`);
    check("Dr Accounts Receivable = 3,000,000,000", je.some((r) => r.accountId === arId && Number(r.debit) === bigCents));

    // Reports SUM across the big amount without int4 overflow.
    const tb = await run(() => storage.trialBalance("2026-01-31"));
    check("trial balance totals reconcile at scale", tb.totalDebit === tb.totalCredit && tb.totalDebit === bigCents, `${tb.totalDebit}/${tb.totalCredit}`);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} bigint-money check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll bigint money tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
