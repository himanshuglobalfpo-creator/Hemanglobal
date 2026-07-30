// ============================================================================
// FIXED ASSETS & DEPRECIATION — schedule math, idempotent posting, disposal
// ============================================================================
// Proves, against a real Postgres and the pure schedule module:
//
//   (1) Straight-line $12,000 / $0 salvage / 12 months → $1,000/mo, the schedule
//       sums exactly to cost, and a non-divisible cost puts the remainder in the
//       LAST period (never over/under-depreciates).
//   (2) POST post-depreciation posts Dr Depreciation Expense / Cr Accumulated
//       Depreciation and is idempotent — double-posting a period is a no-op.
//   (3) Depreciation respects period locks.
//   (4) Disposal posts ONE balanced JE (remove cost + accumulated, book gain/
//       loss) and zeroes the asset's net book value.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/fixed_asset_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDepreciationSchedule, scheduleTotal } from "../shared/depreciation";
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
  // ------------------------------------------------------------------------
  console.log("[1] Pure schedule math (integer cents, last-period remainder)");
  // ------------------------------------------------------------------------
  const sl = computeDepreciationSchedule({ costCents: 1_200_000, salvageCents: 0, usefulLifeMonths: 12, method: "straight_line", acquisitionDate: "2026-01-10" });
  check("straight-line 12,000/12 → every month is $1,000 (100000¢)", sl.every((p) => p.amountCents === 100_000));
  check("straight-line schedule sums to cost (1,200,000¢)", scheduleTotal(sl) === 1_200_000, String(scheduleTotal(sl)));
  check("first period is the acquisition month (2026-01)", sl[0].period === "2026-01", sl[0].period);

  const nd = computeDepreciationSchedule({ costCents: 1_000_000, salvageCents: 0, usefulLifeMonths: 3, method: "straight_line", acquisitionDate: "2026-01-01" });
  check("non-divisible 10,000/3 → first two months 333333¢", nd[0].amountCents === 333_333 && nd[1].amountCents === 333_333, `${nd[0].amountCents},${nd[1].amountCents}`);
  check("non-divisible → LAST period absorbs remainder (333334¢)", nd[2].amountCents === 333_334, String(nd[2].amountCents));
  check("non-divisible schedule sums EXACTLY to cost (1,000,000¢)", scheduleTotal(nd) === 1_000_000, String(scheduleTotal(nd)));

  const ddb = computeDepreciationSchedule({ costCents: 1_000_000, salvageCents: 100_000, usefulLifeMonths: 12, method: "double_declining", acquisitionDate: "2026-01-01" });
  check("double-declining sums to cost - salvage (900,000¢), never over-depreciates", scheduleTotal(ddb) === 900_000, String(scheduleTotal(ddb)));

  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("fixed_asset");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Asset Co', 'asset-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('a@a.test', 'x', 'Asset Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const accts = await run(() => storage.listAccounts());
    const equip = accts.find((a) => a.code === "1500")!;   // Office Equipment (asset)
    const accum = accts.find((a) => a.code === "1510")!;   // Accumulated Depreciation (contra-asset)
    const depExp = accts.find((a) => a.code === "6800")!;  // Depreciation Expense (expense)
    const gainLoss = accts.find((a) => a.code === "4910")!;// Gain/Loss on Asset Disposal (income)
    const bank = accts.find((a) => a.code === "1000")!;    // Checking (asset) — disposal proceeds

    const jeFor = async (source: string, sourceId: number) => {
      const rows = (await pool.query(
        `SELECT jl.account_id AS "accountId", jl.debit, jl.credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.org_id = 1 AND je.source = $1 AND je.source_id = $2`, [source, sourceId]
      )).rows as Array<{ accountId: number; debit: number; credit: number }>;
      return {
        rows,
        dr: rows.reduce((s, r) => s + Number(r.debit), 0),
        cr: rows.reduce((s, r) => s + Number(r.credit), 0),
        entryCount: (await pool.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE org_id=1 AND source=$1 AND source_id=$2`, [source, sourceId])).rows[0].c as number,
      };
    };

    // ------------------------------------------------------------------------
    console.log("\n[2] Straight-line asset: post depreciation, idempotent, ties to cost");
    // ------------------------------------------------------------------------
    const asset = await run(() => storage.createFixedAsset({
      name: "Delivery Van", assetAccountId: equip.id, accumDepAccountId: accum.id, depreciationExpenseAccountId: depExp.id,
      acquisitionDate: "2026-01-05", costCents: 1_200_000, salvageCents: 0, usefulLifeMonths: 12, method: "straight_line",
    } as any));

    const jan = await run(() => storage.postDepreciation(asset.id, "2026-01"));
    check("January posts $1,000 (100000¢)", jan.posted && jan.amountCents === 100_000, `posted=${jan.posted} amt=${jan.amountCents}`);
    let je = await jeFor("depreciation", asset.id);
    check("depreciation JE balances (Dr = Cr = 100000)", je.dr === 100_000 && je.cr === 100_000, `dr ${je.dr} cr ${je.cr}`);
    check("Dr Depreciation Expense", je.rows.some((r) => r.accountId === depExp.id && Number(r.debit) === 100_000));
    check("Cr Accumulated Depreciation", je.rows.some((r) => r.accountId === accum.id && Number(r.credit) === 100_000));

    // Idempotency: double-post the SAME period → no-op, no second JE.
    const janAgain = await run(() => storage.postDepreciation(asset.id, "2026-01"));
    check("re-posting January is a no-op (posted=false)", janAgain.posted === false);
    je = await jeFor("depreciation", asset.id);
    check("no duplicate JE was created (still exactly 1)", je.entryCount === 1, `${je.entryCount} entries`);

    // Post the remaining 11 months → schedule ties to cost, asset fully depreciated.
    for (let m = 2; m <= 12; m++) await run(() => storage.postDepreciation(asset.id, `2026-${String(m).padStart(2, "0")}`));
    const detail = (await run(() => storage.getFixedAssetDetail(asset.id)))!;
    check("accumulated depreciation ties to cost (1,200,000¢)", detail.accumulatedDepreciationCents === 1_200_000, String(detail.accumulatedDepreciationCents));
    check("net book value is zero after full depreciation", detail.netBookValueCents === 0, String(detail.netBookValueCents));
    check("asset flips to 'fully_depreciated'", detail.status === "fully_depreciated", detail.status);

    // ------------------------------------------------------------------------
    console.log("\n[3] Non-divisible cost via storage — last month carries the remainder");
    // ------------------------------------------------------------------------
    const odd = await run(() => storage.createFixedAsset({
      name: "3-month tool", assetAccountId: equip.id, accumDepAccountId: accum.id, depreciationExpenseAccountId: depExp.id,
      acquisitionDate: "2026-01-01", costCents: 1_000_000, salvageCents: 0, usefulLifeMonths: 3, method: "straight_line",
    } as any));
    const p1 = await run(() => storage.postDepreciation(odd.id, "2026-01"));
    const p2 = await run(() => storage.postDepreciation(odd.id, "2026-02"));
    const p3 = await run(() => storage.postDepreciation(odd.id, "2026-03"));
    check("months 1-2 are 333333¢ each, month 3 is 333334¢", p1.amountCents === 333_333 && p2.amountCents === 333_333 && p3.amountCents === 333_334, `${p1.amountCents},${p2.amountCents},${p3.amountCents}`);
    const oddDetail = (await run(() => storage.getFixedAssetDetail(odd.id)))!;
    check("non-divisible posted depreciation sums EXACTLY to cost", oddDetail.accumulatedDepreciationCents === 1_000_000, String(oddDetail.accumulatedDepreciationCents));

    // ------------------------------------------------------------------------
    console.log("\n[4] Disposal posts ONE balanced JE and zeroes net book value");
    // ------------------------------------------------------------------------
    const disp = await run(() => storage.createFixedAsset({
      name: "Old Laptop", assetAccountId: equip.id, accumDepAccountId: accum.id, depreciationExpenseAccountId: depExp.id,
      acquisitionDate: "2026-01-01", costCents: 500_000, salvageCents: 0, usefulLifeMonths: 10, method: "straight_line",
    } as any));
    await run(() => storage.postDepreciation(disp.id, "2026-01")); // 50000
    await run(() => storage.postDepreciation(disp.id, "2026-02")); // 50000 → accumulated 100000, NBV 400000
    const before = (await run(() => storage.getFixedAssetDetail(disp.id)))!;
    check("net book value before disposal = 400,000¢", before.netBookValueCents === 400_000, String(before.netBookValueCents));

    // Sell for $4,500 (450000¢) → gain of 50,000¢ over the 400,000 NBV.
    const result = await run(() => storage.disposeFixedAsset(disp.id, {
      date: "2026-03-15", proceedsCents: 450_000, proceedsAccountId: bank.id, gainLossAccountId: gainLoss.id,
    } as any));
    check("disposal reports a $500 gain (50000¢)", result.gainLossCents === 50_000, String(result.gainLossCents));
    check("disposed asset status is 'disposed'", result.asset.status === "disposed", result.asset.status);
    const dje = await jeFor("asset_disposal", disp.id);
    check("disposal JE balances exactly (Dr = Cr)", dje.dr === dje.cr && dje.dr > 0, `dr ${dje.dr} cr ${dje.cr}`);
    check("disposal removes cost (Cr asset account 500000)", dje.rows.some((r) => r.accountId === equip.id && Number(r.credit) === 500_000));
    check("disposal clears accumulated depreciation (Dr 1510 100000)", dje.rows.some((r) => r.accountId === accum.id && Number(r.debit) === 100_000));
    check("disposal records proceeds (Dr bank 450000)", dje.rows.some((r) => r.accountId === bank.id && Number(r.debit) === 450_000));
    check("disposal books the gain (Cr 4910 50000)", dje.rows.some((r) => r.accountId === gainLoss.id && Number(r.credit) === 50_000));
    // NBV is zeroed: this asset's cost is fully credited out and its accumulated fully debited out.
    const removedCost = dje.rows.filter((r) => r.accountId === equip.id).reduce((s, r) => s + Number(r.credit), 0);
    const removedAccum = dje.rows.filter((r) => r.accountId === accum.id).reduce((s, r) => s + Number(r.debit), 0);
    check("net book value zeroed (cost 500000 removed, accum 100000 cleared)", removedCost === 500_000 && removedAccum === 100_000);

    // A scrap (no proceeds) books the whole NBV as a loss and still balances.
    const scrap = await run(() => storage.createFixedAsset({
      name: "Broken Printer", assetAccountId: equip.id, accumDepAccountId: accum.id, depreciationExpenseAccountId: depExp.id,
      acquisitionDate: "2026-01-01", costCents: 300_000, salvageCents: 0, usefulLifeMonths: 10, method: "straight_line",
    } as any));
    const scrapResult = await run(() => storage.disposeFixedAsset(scrap.id, { date: "2026-02-01", proceedsCents: 0, gainLossAccountId: gainLoss.id } as any));
    check("scrap with no proceeds is a loss of the full cost (−300000¢)", scrapResult.gainLossCents === -300_000, String(scrapResult.gainLossCents));
    const sje = await jeFor("asset_disposal", scrap.id);
    check("scrap disposal JE balances", sje.dr === sje.cr && sje.dr === 300_000, `dr ${sje.dr} cr ${sje.cr}`);

    // ------------------------------------------------------------------------
    console.log("\n[5] Depreciation respects period locks");
    // ------------------------------------------------------------------------
    const locked = await run(() => storage.createFixedAsset({
      name: "Locked-period asset", assetAccountId: equip.id, accumDepAccountId: accum.id, depreciationExpenseAccountId: depExp.id,
      acquisitionDate: "2025-01-01", costCents: 120_000, salvageCents: 0, usefulLifeMonths: 12, method: "straight_line",
    } as any));
    await run(() => storage.closePeriod({ lockDate: "2025-01-31" } as any));
    await expectReject(
      "posting depreciation into a closed period is blocked",
      () => run(() => storage.postDepreciation(locked.id, "2025-01")),
      /closed|lock/i
    );

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} fixed-asset check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll fixed-asset & depreciation tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
