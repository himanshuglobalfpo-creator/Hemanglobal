// ============================================================================
// FX REVALUATION — period-end unrealized adjustment of OPEN foreign balances
// ============================================================================
// Exercises the REAL storage wiring against a real Postgres:
//
//   (1) A €100 invoice booked @ 1.10 (base $110), revalued at 1.15, posts an
//       unrealized GAIN of $5.00 (Dr A/R / Cr Unrealized FX Gain).
//   (2) The balance sheet as of the revaluation date still satisfies A = L + E.
//   (3) Reversal (dated the start of the next period) restores the prior
//       carrying value EXACTLY — A/R back to the original $110.
//   (4) A foreign bill revalues the other way (A/P), and a missing as-of rate
//       fails loudly instead of guessing.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/fx_revaluation_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("fx_revaluation");
  try {
    await pool.query(`INSERT INTO organizations (name, slug, base_currency) VALUES ('FX Co', 'fx-co', 'USD')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('f@f.test', 'x', 'FX Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const accts = await run(() => storage.listAccounts());
    const sales = accts.find((a) => a.code === "4000")!;
    const expense = accts.find((a) => a.code === "6000")!;
    const arCode = "1100", apCode = "2000";
    const arId = accts.find((a) => a.code === arCode)!.id;
    const apId = accts.find((a) => a.code === apCode)!.id;
    const customerId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Euro Buyer') RETURNING id`)).rows[0].id as number;
    const vendorId = (await pool.query(`INSERT INTO vendors (org_id, name) VALUES (1,'Euro Vendor') RETURNING id`)).rows[0].id as number;

    const balOf = async (accountId: number, asOf: string) => {
      const balances = await run(() => storage.accountBalances(asOf));
      return balances.get(accountId)?.balance ?? 0;
    };
    const jeLines = async (source: string, sourceId: number) => {
      const rows = (await pool.query(
        `SELECT jl.account_id AS "accountId", jl.debit, jl.credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.org_id = 1 AND je.source = $1 AND je.source_id = $2`, [source, sourceId]
      )).rows as Array<{ accountId: number; debit: number; credit: number }>;
      return { rows, dr: rows.reduce((s, r) => s + Number(r.debit), 0), cr: rows.reduce((s, r) => s + Number(r.credit), 0) };
    };

    // ------------------------------------------------------------------------
    console.log("\n[setup] €100 invoice booked @ 1.10 → base $110 (A/R 11000¢)");
    // ------------------------------------------------------------------------
    const inv = await run(() => storage.createInvoice({
      currency: "EUR", fxRate: 1.10, customerId, date: "2026-06-15", dueDate: "2026-07-15", taxRate: 0,
      lines: [{ description: "Consulting", quantity: 1, rate: 100, incomeAccountId: sales.id }],
    } as any));
    check("invoice foreign total = €100 (10000¢)", inv.foreignTotal === 10000, String(inv.foreignTotal));
    check("invoice base total = $110 (11000¢)", inv.total === 11000, String(inv.total));
    check("A/R base carrying value = 11000¢ before revaluation", (await balOf(arId, "2026-06-30")) === 11000);

    // ------------------------------------------------------------------------
    console.log("\n[1] Missing as-of rate fails loudly (never guesses)");
    // ------------------------------------------------------------------------
    await expectReject(
      "revalue with no EUR→USD rate on the as-of date is rejected",
      () => run(() => storage.revalueFx({ asOfDate: "2026-06-30" } as any)),
      /No FX rate for EUR/i
    );

    // ------------------------------------------------------------------------
    console.log("\n[2] Revalue at 1.15 → unrealized gain of $5.00 (Dr A/R / Cr Unrealized FX Gain)");
    // ------------------------------------------------------------------------
    await run(() => storage.upsertFxRate({ date: "2026-06-30", fromCode: "EUR", toCode: "USD", rate: 1.15 }));
    const { revaluation, lines } = await run(() => storage.revalueFx({ asOfDate: "2026-06-30" } as any));
    check("run recorded a $5.00 unrealized gain", revaluation.totalGainCents === 500 && revaluation.totalLossCents === 0, `gain ${revaluation.totalGainCents} loss ${revaluation.totalLossCents}`);
    const line = lines.find((l) => l.docType === "invoice" && l.docId === inv.id)!;
    check("per-doc detail: revalued 11500¢, booking 11000¢, diff +500¢", line.revaluedBaseCents === 11500 && line.bookingBaseCents === 11000 && line.diffCents === 500, `${line.revaluedBaseCents}/${line.bookingBaseCents}/${line.diffCents}`);
    const je = await jeLines("fx_revaluation", revaluation.id);
    check("adjusting JE balances (Dr = Cr = 500)", je.dr === 500 && je.cr === 500, `dr ${je.dr} cr ${je.cr}`);
    check("Dr Accounts Receivable 500", je.rows.some((r) => r.accountId === arId && Number(r.debit) === 500));
    const unrealGain = (await run(() => storage.listAccounts())).find((a) => a.code === "4960");
    check("Unrealized FX Gain account was auto-created (4960)", !!unrealGain);
    check("Cr Unrealized FX Gain 500", !!unrealGain && je.rows.some((r) => r.accountId === unrealGain!.id && Number(r.credit) === 500));
    check("A/R revalued carrying value = 11500¢ as of 2026-06-30", (await balOf(arId, "2026-06-30")) === 11500);

    // ------------------------------------------------------------------------
    console.log("\n[3] Balance sheet as of the revaluation date still balances (A = L + E)");
    // ------------------------------------------------------------------------
    const bs = await run(() => storage.balanceSheet("2026-06-30"));
    check("A = L + E holds after revaluation", bs.totalAssets === bs.totalLiabilities + bs.totalEquity, `A ${bs.totalAssets} L ${bs.totalLiabilities} E ${bs.totalEquity}`);

    // ------------------------------------------------------------------------
    console.log("\n[4] Reversal restores the prior carrying value exactly");
    // ------------------------------------------------------------------------
    const reversed = await run(() => storage.reverseFxRevaluation(revaluation.id));
    check("revaluation is now 'reversed'", reversed.status === "reversed", reversed.status);
    check("reversal dated the start of the next period (2026-07-01)", reversed.reversalDate === "2026-07-01", String(reversed.reversalDate));
    const rev = await jeLines("fx_revaluation_reversal", revaluation.id);
    check("reversal JE balances (Dr = Cr = 500)", rev.dr === 500 && rev.cr === 500, `dr ${rev.dr} cr ${rev.cr}`);
    check("A/R restored to 11000¢ after reversal (as of 2026-07-01)", (await balOf(arId, "2026-07-01")) === 11000);
    await expectReject(
      "reversing the same revaluation twice is rejected",
      () => run(() => storage.reverseFxRevaluation(revaluation.id)),
      /already been reversed/i
    );

    // ------------------------------------------------------------------------
    console.log("\n[5] A foreign BILL revalues against A/P (loss when the base value of a payable rises)");
    // ------------------------------------------------------------------------
    const bill = await run(() => storage.createBill({
      currency: "EUR", fxRate: 1.10, vendorId, date: "2026-06-10", dueDate: "2026-07-10", taxRate: 0,
      lines: [{ description: "Supplies", quantity: 1, rate: 200, expenseAccountId: expense.id }],
    } as any));
    check("bill base total = $220 (22000¢)", bill.total === 22000, String(bill.total));
    // New period-end at 1.20 → payable now €200 × 1.20 = $240 → $20 loss.
    await run(() => storage.upsertFxRate({ date: "2026-09-30", fromCode: "EUR", toCode: "USD", rate: 1.20 }));
    const billRun = await run(() => storage.revalueFx({ asOfDate: "2026-09-30", currency: "EUR" } as any));
    // The invoice is back to booking (its revaluation was reversed), so it revalues too at 1.20:
    //   invoice: €100 × 1.20 = 12000 vs 11000 → +1000 gain
    //   bill:    €200 × 1.20 = 24000 vs 22000 → +2000 loss
    check("bill-inclusive run books a $20 loss and a $10 gain", billRun.revaluation.totalLossCents === 2000 && billRun.revaluation.totalGainCents === 1000, `loss ${billRun.revaluation.totalLossCents} gain ${billRun.revaluation.totalGainCents}`);
    const bje = await jeLines("fx_revaluation", billRun.revaluation.id);
    check("combined revaluation JE balances", bje.dr === bje.cr && bje.dr > 0, `dr ${bje.dr} cr ${bje.cr}`);
    check("A/P base value raised by the loss (Cr A/P 2000)", bje.rows.some((r) => r.accountId === apId && Number(r.credit) === 2000));

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} FX revaluation check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll FX revaluation tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
