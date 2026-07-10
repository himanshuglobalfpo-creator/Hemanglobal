// ============================================================================
// FUTURE-DATED DOCUMENTS (BUG-005) — warn in soft mode, reject in strict mode
// ============================================================================
// Proves, against the pure helper and a real Postgres:
//
//   (1) The pure futureDatedWarning() flags dates beyond the grace window only.
//   (2) With default org settings (grace 0, non-strict), a future-dated invoice
//       is CREATED but carries a `warnings` array the client can surface.
//   (3) A grace window suppresses the warning inside the allowed horizon.
//   (4) A bill and a MANUAL journal entry get the same treatment.
//   (5) With strict_future_dates enabled, a future-dated document is REJECTED
//       (nothing is written) and the error is a 400.
//   (6) A past/today-dated document is never flagged.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/future_dated_test.ts
// ============================================================================

import { futureDatedWarning, isoToday, daysAhead } from "../shared/dates";
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
async function expectReject(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    failures++;
    console.error(`  ✗ ${label} — expected an error, none thrown`);
  } catch (e: any) {
    check(label, pattern.test(String(e?.message)), `got: ${e?.message}`);
  }
}

// YYYY-MM-DD `days` from today (UTC).
function offsetDate(days: number): string {
  return isoToday(Date.now() + days * 86_400_000);
}

async function main() {
  // ------------------------------------------------------------------------
  console.log("[1] Pure futureDatedWarning() helper");
  // ------------------------------------------------------------------------
  const today = "2026-07-10";
  check("today is not flagged", futureDatedWarning(today, 0, "invoice", today) === null);
  check("past date is not flagged", futureDatedWarning("2026-07-01", 0, "invoice", today) === null);
  check("tomorrow IS flagged at grace 0", futureDatedWarning("2026-07-11", 0, "invoice", today) !== null);
  check("within grace window is not flagged", futureDatedWarning("2026-07-15", 10, "invoice", today) === null);
  check("beyond grace window IS flagged", futureDatedWarning("2026-07-25", 10, "invoice", today) !== null);
  check("daysAhead counts whole UTC days", daysAhead("2026-07-25", today) === 15, String(daysAhead("2026-07-25", today)));

  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("future_dated");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Future Co', 'future-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('f@f.test', 'x', 'Future Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const accts = await run(() => storage.listAccounts());
    const revenue = accts.find((a) => a.code === "4000")!;
    const cust = await run(() => storage.createCustomer({ name: "Future Customer" } as any));
    const vendor = (await pool.query(`INSERT INTO vendors (org_id, name) VALUES (1,'Future Vendor') RETURNING id`)).rows[0].id as number;

    const far = offsetDate(30);   // 30 days out — clearly future
    const near = offsetDate(1);   // tomorrow

    // ------------------------------------------------------------------------
    console.log("\n[2] Soft mode (default): future-dated invoice is created WITH a warning");
    // ------------------------------------------------------------------------
    const inv = await run(() => storage.createInvoice({
      customerId: cust.id, date: far, dueDate: offsetDate(60), taxRate: 0,
      lines: [{ description: "Consulting", quantity: 1, rate: 100, incomeAccountId: revenue.id }],
    } as any));
    check("future invoice was created", !!inv.id);
    check("invoice carries a warnings array", Array.isArray((inv as any).warnings) && (inv as any).warnings.length === 1, JSON.stringify((inv as any).warnings));
    check("warning names the future date", String((inv as any).warnings?.[0]).includes(far));

    // ------------------------------------------------------------------------
    console.log("\n[3] A today-dated invoice carries NO warning");
    // ------------------------------------------------------------------------
    const invToday = await run(() => storage.createInvoice({
      customerId: cust.id, date: isoToday(), dueDate: offsetDate(30), taxRate: 0,
      lines: [{ description: "Consulting", quantity: 1, rate: 50, incomeAccountId: revenue.id }],
    } as any));
    check("today invoice has no warnings", (invToday as any).warnings === undefined);

    // ------------------------------------------------------------------------
    console.log("\n[4] A grace window suppresses the near-future warning");
    // ------------------------------------------------------------------------
    await pool.query(`UPDATE organizations SET future_dated_grace_days = 7 WHERE id = 1`);
    const invNear = await run(() => storage.createInvoice({
      customerId: cust.id, date: near, dueDate: offsetDate(30), taxRate: 0,
      lines: [{ description: "Consulting", quantity: 1, rate: 25, incomeAccountId: revenue.id }],
    } as any));
    check("tomorrow invoice is within the 7-day grace → no warning", (invNear as any).warnings === undefined);
    await pool.query(`UPDATE organizations SET future_dated_grace_days = 0 WHERE id = 1`);

    // ------------------------------------------------------------------------
    console.log("\n[5] Bills and manual journal entries get the same warning");
    // ------------------------------------------------------------------------
    const bill = await run(() => storage.createBill({
      vendorId: vendor, date: far, dueDate: offsetDate(60), taxRate: 0,
      lines: [{ description: "Supplies", quantity: 1, rate: 40, expenseAccountId: accts.find((a) => a.code === "6000")!.id }],
    } as any));
    check("future bill carries a warning", Array.isArray((bill as any).warnings) && (bill as any).warnings.length === 1);

    const cash = accts.find((a) => a.code === "1000")!;
    const je = await run(() => storage.postJournalEntry({
      date: far, memo: "Prepaid something",
      lines: [
        { accountId: cash.id, debit: 10000, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 10000 },
      ],
    } as any, { futureDateCheck: true }));
    check("manual future JE carries a warning", Array.isArray((je as any).warnings) && (je as any).warnings!.length === 1);

    // Internal JE posting (no futureDateCheck) is NOT policed.
    const jePlain = await run(() => storage.postJournalEntry({
      date: far, memo: "system entry",
      lines: [
        { accountId: cash.id, debit: 5000, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 5000 },
      ],
    } as any));
    check("internal JE (no opt-in) has no warnings", (jePlain as any).warnings === undefined);

    // ------------------------------------------------------------------------
    console.log("\n[6] Strict mode: future-dated documents are REJECTED (nothing written)");
    // ------------------------------------------------------------------------
    await pool.query(`UPDATE organizations SET strict_future_dates = true WHERE id = 1`);
    const invCountBefore = (await pool.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE org_id = 1`)).rows[0].c as number;
    await expectReject(
      "strict mode rejects a future-dated invoice",
      () => run(() => storage.createInvoice({
        customerId: cust.id, date: far, dueDate: offsetDate(60), taxRate: 0,
        lines: [{ description: "Consulting", quantity: 1, rate: 100, incomeAccountId: revenue.id }],
      } as any)),
      /future|strict/i
    );
    const invCountAfter = (await pool.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE org_id = 1`)).rows[0].c as number;
    check("no invoice was written by the rejected create", invCountAfter === invCountBefore, `${invCountBefore} → ${invCountAfter}`);

    // The thrown error is a 400 (httpStatus).
    try {
      await run(() => storage.createBill({
        vendorId: vendor, date: far, dueDate: offsetDate(60), taxRate: 0,
        lines: [{ description: "Supplies", quantity: 1, rate: 40, expenseAccountId: accts.find((a) => a.code === "6000")!.id }],
      } as any));
      failures++; console.error("  ✗ strict mode should reject a future bill");
    } catch (e: any) {
      check("strict-mode rejection is a 400", e?.httpStatus === 400, String(e?.httpStatus));
    }

    // A today-dated invoice still works under strict mode.
    const okInv = await run(() => storage.createInvoice({
      customerId: cust.id, date: isoToday(), dueDate: offsetDate(30), taxRate: 0,
      lines: [{ description: "Consulting", quantity: 1, rate: 10, incomeAccountId: revenue.id }],
    } as any));
    check("today-dated invoice is allowed even in strict mode", !!okInv.id && (okInv as any).warnings === undefined);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} future-dated check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll future-dated document tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
