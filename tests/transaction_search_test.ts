// ============================================================================
// ADVANCED TRANSACTION SEARCH — unified taxonomy + filters
// ============================================================================
// Proves, against a real Postgres, that searchTransactions() unifies every
// transaction type without double-counting and that each filter narrows
// correctly:
//   (1) no filters → one row per business document (invoice, bill, expense,
//       deposit, manual journal) — system JEs behind invoices/bills are NOT
//       listed as journals.
//   (2) type, contact, referenceNumber, amount comparator, date range, and free
//       text each filter as expected.
//   (3) amounts are normalized cents (bank expense shows abs value).
//   (4) recentTransactions returns newest-first.
//
// Run: tsx tests/transaction_search_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("txn_search");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Search Co', 'search-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('s@s.test', 'x', 'Search Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const revenue = accts.find((a) => a.code === "4000")!;
    const expenseAcct = accts.find((a) => a.code === "6000")!;

    const customer = await run(() => storage.createCustomer({ name: "Globex Inc" } as any));
    const vendor = await run(() => storage.createVendor({ name: "Acme Supply" } as any));

    // Invoice ($500) and Bill ($200).
    const invoice = await run(() => storage.createInvoice({ customerId: customer.id, date: "2026-05-01", dueDate: "2026-05-31", taxRate: 0, lines: [{ description: "Consulting", quantity: 1, rate: 500, incomeAccountId: revenue.id }] } as any));
    await run(() => storage.createBill({ vendorId: vendor.id, date: "2026-05-02", dueDate: "2026-05-30", taxRate: 0, lines: [{ description: "Parts", quantity: 1, rate: 200, expenseAccountId: expenseAcct.id }] } as any));

    // Bank expense (−$80, payee) and deposit (+$1500), inserted directly.
    await pool.query(`INSERT INTO bank_transactions (org_id, bank_account_id, date, description, amount, source, payee) VALUES (1,$1,'2026-05-03','UBER EATS',-8000,'csv','Uber Eats')`, [bank.id]);
    await pool.query(`INSERT INTO bank_transactions (org_id, bank_account_id, date, description, amount, source) VALUES (1,$1,'2026-05-04','CUSTOMER WIRE',150000,'csv')`, [bank.id]);

    // Manual journal entry ($300, memo "Owner draw").
    await run(() => storage.postJournalEntry({ date: "2026-05-05", memo: "Owner draw", source: "manual", lines: [{ accountId: bank.id, debit: 30000, credit: 0 }, { accountId: revenue.id, debit: 0, credit: 30000 }] } as any));

    // ------------------------------------------------------------------------
    console.log("\n[1] No filters → one row per business document, no double-count");
    // ------------------------------------------------------------------------
    const all = await run(() => storage.searchTransactions({}, 100, 0));
    check("5 transactions total", all.total === 5, String(all.total));
    const byType = (t: string) => all.rows.filter((r) => r.type === t);
    check("exactly one invoice (its system JE is not listed as a journal)", byType("invoice").length === 1);
    check("exactly one bill", byType("bill").length === 1);
    check("one expense + one deposit from bank txns", byType("expense").length === 1 && byType("deposit").length === 1);
    check("exactly one manual journal", byType("journal").length === 1, JSON.stringify(byType("journal")));

    // ------------------------------------------------------------------------
    console.log("\n[2] Filters narrow correctly");
    // ------------------------------------------------------------------------
    const inv = await run(() => storage.searchTransactions({ type: "invoice" }, 100, 0));
    check("type=invoice → only invoices", inv.rows.every((r) => r.type === "invoice") && inv.total === 1);
    check("invoice amount is cents ($500 = 50000)", inv.rows[0].amountCents === 50000, String(inv.rows[0].amountCents));
    check("invoice carries the customer as contact", inv.rows[0].contactName === "Globex Inc", String(inv.rows[0].contactName));

    const exp = await run(() => storage.searchTransactions({ type: "expense" }, 100, 0));
    check("bank expense amount is normalized to abs cents ($80 = 8000)", exp.rows[0].amountCents === 8000, String(exp.rows[0].amountCents));
    check("bank expense contact is the payee", exp.rows[0].contactName === "Uber Eats", String(exp.rows[0].contactName));

    const byContact = await run(() => storage.searchTransactions({ contact: "globex" }, 100, 0));
    check("contact filter matches the invoice's customer", byContact.total === 1 && byContact.rows[0].type === "invoice");

    const byRef = await run(() => storage.searchTransactions({ referenceNumber: invoice.number }, 100, 0));
    check("reference-number filter finds the invoice", byRef.total === 1 && byRef.rows[0].referenceNumber === invoice.number, invoice.number);

    const gte = await run(() => storage.searchTransactions({ amountOp: "gte", amountCents: 100000 }, 100, 0));
    check("amount ≥ $1000 → only the $1500 deposit", gte.total === 1 && gte.rows[0].type === "deposit", JSON.stringify(gte.rows.map((r) => [r.type, r.amountCents])));

    const eq = await run(() => storage.searchTransactions({ amountOp: "eq", amountCents: 20000 }, 100, 0));
    check("amount = $200 → only the bill", eq.total === 1 && eq.rows[0].type === "bill");

    const range = await run(() => storage.searchTransactions({ dateFrom: "2026-05-03", dateTo: "2026-05-04" }, 100, 0));
    check("date range 05-03..05-04 → expense + deposit", range.total === 2 && range.rows.every((r) => r.type === "expense" || r.type === "deposit"), JSON.stringify(range.rows.map((r) => r.date)));

    const text = await run(() => storage.searchTransactions({ q: "owner" }, 100, 0));
    check("free-text 'owner' matches the journal memo", text.total === 1 && text.rows[0].type === "journal");

    // ------------------------------------------------------------------------
    console.log("\n[3] Recent transactions are newest-first");
    // ------------------------------------------------------------------------
    const recent = await run(() => storage.recentTransactions(10));
    check("recent list is ordered by date desc (journal 05-05 first)", recent[0].type === "journal", JSON.stringify(recent.map((r) => [r.type, r.date])));

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} transaction-search check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll advanced transaction-search tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
