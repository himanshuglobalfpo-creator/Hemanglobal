// ============================================================================
// 1099 VENDOR TRACKING — cash paid per calendar year, threshold, tax ID
// ============================================================================
// Proves, against a real Postgres:
//
//   (1) The 1099 Summary sums ACTUAL PAYMENTS (cash basis) to a tracked vendor
//       within the calendar year, across multiple partial payments.
//   (2) Payments in a different year are excluded (year boundary).
//   (3) Non-tracked vendors never appear.
//   (4) Tracked vendors below the threshold land in `belowThreshold`, not `rows`.
//   (5) The vendor's tax ID is reported, and a missing tax ID is flagged.
//
// Run: tsx tests/vendor_1099_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("vendor_1099");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('1099 Co', '1099-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('t@t.test', 'x', '1099 Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const expense = accts.find((a) => a.code === "6000")!;

    // Vendors: A tracked (contractor), B not tracked, C tracked but below threshold + no tax ID.
    const contractor = await run(() => storage.createVendor({ name: "Ace Contracting", track1099: true, taxId: "12-3456789" } as any));
    const supplier = await run(() => storage.createVendor({ name: "Bulk Supplier", track1099: false } as any));
    const smallGuy = await run(() => storage.createVendor({ name: "Casual Helper", track1099: true } as any)); // no taxId

    const mkBill = (vendorId: number, date: string, amount: number) =>
      run(() => storage.createBill({
        vendorId, date, dueDate: date, taxRate: 0,
        lines: [{ description: "Services", quantity: 1, rate: amount, expenseAccountId: expense.id }],
      } as any));
    const pay = (billId: number, date: string, amount: number) =>
      run(() => storage.payBill({ billId, date, amount, bankAccountId: bank.id } as any));

    // ------------------------------------------------------------------------
    console.log("\n[setup] bills + payments across 2025/2026");
    // ------------------------------------------------------------------------
    // Contractor: $1,000 in 2026 paid as $600 + $400 (two payments, same year).
    const cBill2026 = await mkBill(contractor.id, "2026-02-01", 1000);
    await pay(cBill2026.id, "2026-03-01", 600);
    await pay(cBill2026.id, "2026-04-01", 400);
    // Contractor: $800 in 2025 (must NOT count toward 2026).
    const cBill2025 = await mkBill(contractor.id, "2025-11-01", 800);
    await pay(cBill2025.id, "2025-12-15", 800);

    // Supplier (not tracked): $2,000 paid in 2026.
    const sBill = await mkBill(supplier.id, "2026-02-10", 2000);
    await pay(sBill.id, "2026-03-10", 2000);

    // Casual helper (tracked, no tax ID): $500 in 2026 — below the $600 threshold.
    const hBill = await mkBill(smallGuy.id, "2026-02-20", 500);
    await pay(hBill.id, "2026-03-20", 500);

    // ------------------------------------------------------------------------
    console.log("\n[1] 2026 1099 summary (threshold $600)");
    // ------------------------------------------------------------------------
    const rpt = await run(() => storage.report1099Summary(2026, 60000));
    const ace = rpt.rows.find((r) => r.vendorId === contractor.id);
    check("Ace Contracting is over threshold and listed", !!ace, JSON.stringify(rpt.rows));
    check("Ace paid = $1,000 (100000¢) — both 2026 payments, NOT the 2025 one", ace?.paidCents === 100000, String(ace?.paidCents));
    check("Ace tax ID is reported", ace?.taxId === "12-3456789", String(ace?.taxId));
    check("Ace not flagged missingTaxId", ace?.missingTaxId === false);
    check("non-tracked Bulk Supplier is absent from the report", !rpt.rows.some((r) => r.vendorId === supplier.id) && !rpt.belowThreshold.some((r) => r.vendorId === supplier.id));
    const helper = rpt.belowThreshold.find((r) => r.vendorId === smallGuy.id);
    check("Casual Helper ($500) is in belowThreshold, not rows", !!helper && !rpt.rows.some((r) => r.vendorId === smallGuy.id), JSON.stringify(rpt.belowThreshold));
    check("Casual Helper below-threshold amount = 50000¢", helper?.paidCents === 50000, String(helper?.paidCents));

    // ------------------------------------------------------------------------
    console.log("\n[2] 2025 1099 summary picks up the prior-year payment");
    // ------------------------------------------------------------------------
    const rpt25 = await run(() => storage.report1099Summary(2025, 60000));
    const ace25 = rpt25.rows.find((r) => r.vendorId === contractor.id);
    check("Ace over threshold in 2025 with $800 (80000¢)", ace25?.paidCents === 80000, String(ace25?.paidCents));

    // ------------------------------------------------------------------------
    console.log("\n[3] A tracked vendor with no tax ID over threshold is flagged");
    // ------------------------------------------------------------------------
    const bigCasual = await mkBill(smallGuy.id, "2026-05-01", 700);
    await pay(bigCasual.id, "2026-05-15", 700);
    const rpt2 = await run(() => storage.report1099Summary(2026, 60000));
    const helper2 = rpt2.rows.find((r) => r.vendorId === smallGuy.id);
    check("Casual Helper now over threshold (500+700=120000¢)", helper2?.paidCents === 120000, String(helper2?.paidCents));
    check("missing tax ID is flagged for compliance", helper2?.missingTaxId === true);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} 1099 check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll 1099 vendor tracking tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
