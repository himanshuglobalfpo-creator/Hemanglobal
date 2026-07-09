// ============================================================================
// ESTIMATES (quotes) → INVOICE — conversion, totals parity, expiry
// ============================================================================
// Exercises the REAL storage wiring against a real Postgres:
//
//   (1) An estimate posts NO journal entry (it is a quote).
//   (2) Converting it produces an invoice whose subtotal/tax/total EQUAL the
//       estimate's, and whose journal entry balances exactly — reusing the
//       createInvoice() rounding + tax path (no math duplicated).
//   (3) Converting the same estimate twice is rejected.
//   (4) An expired estimate cannot be converted; the expiry sweep flips
//       past-expiry draft/sent estimates to 'expired'.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/estimate_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  let shutdown: () => Promise<void> = async () => {};
  if (!process.env.DATABASE_URL) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = (await import("embedded-postgres")).default;
    } catch {
      console.error("This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`.");
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-est-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "postgres", password: "password", port: 55448,
      persistent: false, createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_estimate_test");
    process.env.DATABASE_URL = "postgresql://postgres:password@localhost:55448/ledgerlite_estimate_test";
    shutdown = async () => { await epg.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  }

  try {
    const { pool, runMigrations, storage, seedOrgDefaults } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    await runMigrations();
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Est Co', 'est-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('e@e.test', 'x', 'Est Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const jeBalance = async (invoiceId: number) => {
      const rows = (await pool.query(
        `SELECT jl.debit, jl.credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.org_id = 1 AND je.source = 'invoice' AND je.source_id = $1`, [invoiceId]
      )).rows as Array<{ debit: number; credit: number }>;
      return {
        dr: rows.reduce((s, r) => s + Number(r.debit), 0),
        cr: rows.reduce((s, r) => s + Number(r.credit), 0),
        lineCount: rows.length,
      };
    };

    const accts = await run(() => storage.listAccounts());
    const sales = accts.find((a) => a.code === "4000")!;
    const customerId = (await pool.query(`INSERT INTO customers (org_id, name, email) VALUES (1,'Quote Buyer','buyer@x.test') RETURNING id`)).rows[0].id as number;

    // ------------------------------------------------------------------------
    console.log("\n[1] Create an estimate — $250 subtotal, 10% tax — NO journal entry");
    // ------------------------------------------------------------------------
    const est = await run(() => storage.createEstimate({
      customerId, date: "2026-04-01", expiryDate: "2026-04-30", taxRate: 10, notes: "Q2 proposal",
      lines: [
        { description: "Consulting", quantity: 2, rate: 100, incomeAccountId: sales.id },
        { description: "Setup fee", quantity: 1, rate: 50, incomeAccountId: sales.id },
      ],
    } as any));
    check("estimate number is EST-0001", est.number === "EST-0001", est.number);
    check("estimate status is 'draft'", est.status === "draft", est.status);
    check("estimate subtotal = 25000¢ ($250)", est.subtotalCents === 25000, String(est.subtotalCents));
    check("estimate tax = 2500¢ ($25)", est.taxCents === 2500, String(est.taxCents));
    check("estimate total = 27500¢ ($275)", est.totalCents === 27500, String(est.totalCents));
    const jeAfterEstimate = (await pool.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE org_id = 1`)).rows[0].c as number;
    check("estimate posted ZERO journal entries", jeAfterEstimate === 0, `got ${jeAfterEstimate}`);

    // ------------------------------------------------------------------------
    console.log("\n[2] Convert → invoice: totals equal the estimate's, JE balances");
    // ------------------------------------------------------------------------
    const { estimate: convEst, invoice } = await run(() => storage.convertEstimate(est.id, {} as any));
    check("invoice subtotal equals estimate subtotal (25000)", invoice.subtotal === est.subtotalCents, String(invoice.subtotal));
    check("invoice tax equals estimate tax (2500)", invoice.tax === est.taxCents, String(invoice.tax));
    check("invoice total equals estimate total (27500)", invoice.total === est.totalCents, String(invoice.total));
    check("invoice links back to the estimate", invoice.estimateId === est.id, String(invoice.estimateId));
    check("estimate status flips to 'invoiced'", convEst.status === "invoiced", convEst.status);
    const bal = await jeBalance(invoice.id);
    check("invoice JE has 3 lines (Dr A/R, Cr Sales, Cr Tax)", bal.lineCount === 3, `${bal.lineCount} lines`);
    check("invoice JE balances exactly (Dr = Cr = 27500)", bal.dr === 27500 && bal.cr === 27500, `dr ${bal.dr} cr ${bal.cr}`);

    // ------------------------------------------------------------------------
    console.log("\n[3] Converting the same estimate twice is rejected");
    // ------------------------------------------------------------------------
    await expectReject(
      "second convert of an already-invoiced estimate is blocked",
      () => run(() => storage.convertEstimate(est.id, {} as any)),
      /already been converted/i
    );

    // ------------------------------------------------------------------------
    console.log("\n[4] Expiry: past-expiry estimate is swept to 'expired' and cannot convert");
    // ------------------------------------------------------------------------
    const stale = await run(() => storage.createEstimate({
      customerId, date: "2020-01-01", expiryDate: "2020-01-31", taxRate: 0,
      lines: [{ description: "Old quote", quantity: 1, rate: 10, incomeAccountId: sales.id }],
    } as any));
    check("stale estimate starts 'draft'", stale.status === "draft");
    const sweptCount = await run(() => storage.expireEstimates("2026-04-05"));
    check("expiry sweep marked at least one estimate expired", sweptCount >= 1, `swept ${sweptCount}`);
    const staleAfter = (await run(() => storage.getEstimate(stale.id)))!;
    check("stale estimate is now 'expired'", staleAfter.status === "expired", staleAfter.status);
    await expectReject(
      "an expired estimate cannot be converted",
      () => run(() => storage.convertEstimate(stale.id, {} as any)),
      /expired/i
    );
    // The already-invoiced estimate is NOT touched by the sweep.
    const convEstAfterSweep = (await run(() => storage.getEstimate(est.id)))!;
    check("sweep left the invoiced estimate alone", convEstAfterSweep.status === "invoiced");

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures) {
    console.error(`\n❌ ${failures} estimate check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll estimate tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
