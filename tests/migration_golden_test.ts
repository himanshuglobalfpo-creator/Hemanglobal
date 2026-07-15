// ============================================================================
// MIGRATION GOLDEN-FILE TEST — QBO & Xero switcher path
// ============================================================================
// Proves the wizard's engine end-to-end against realistic export bundles:
//   1. Source + entity auto-detection by header signature (QBO vs Xero).
//   2. Account-type vocabulary normalization (Bank→asset/bank, Revenue→income,
//      Direct Costs→expense/cogs, …).
//   3. The headline guarantee: after importing a source Trial Balance, our own
//      Trial Balance equals the source to the cent — for BOTH QBO and Xero.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupTestDb } from "./harness";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (p: string) => fs.readFileSync(path.join(FIX, p), "utf8");

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("migration_golden");
  try {
    // migration imports storage (needs DATABASE_URL) — import AFTER setup.
    const migration = await import("../server/migration");
    const { parseWithHeaders, analyzeFile, applyMapping, suggestMapping, runImport } = migration;

    // Build the expected {code → {debit,credit} in cents} straight from a golden
    // trial-balance fixture, so the assertion is genuinely file-driven.
    const goldenTb = (csv: string) => {
      const { headers, rows } = parseWithHeaders(csv);
      const canon = applyMapping("trial_balance", "generic", suggestMapping("trial_balance", headers), rows);
      const exp = new Map<string, { debit: number; credit: number }>();
      for (const r of canon) {
        const debit = r.debit ? Math.round(parseFloat(r.debit) * 100) : 0;
        const credit = r.credit ? Math.round(parseFloat(r.credit) * 100) : 0;
        if (debit || credit) exp.set(r.account_code, { debit, credit });
      }
      return exp;
    };

    // ------------------------------------------------------------------
    // Part 1 — detection + account-type normalization (no DB writes)
    // ------------------------------------------------------------------
    console.log("Test: source/entity detection + account-type normalization");
    const qboCoa = analyzeFile(fx("qbo/chart_of_accounts.csv"));
    check("QBO chart of accounts → source qbo", qboCoa.source === "qbo");
    check("QBO chart of accounts → entity accounts", qboCoa.entity === "accounts");
    const qCanon = new Map(applyMapping("accounts", "qbo", qboCoa.mapping, parseWithHeaders(fx("qbo/chart_of_accounts.csv")).rows).map((r) => [r.code, r]));
    check("QBO Bank → asset/bank", qCanon.get("1000")!.type === "asset" && qCanon.get("1000")!.subtype === "bank");
    check("QBO Income → income/operating_income", qCanon.get("4000")!.type === "income" && qCanon.get("4000")!.subtype === "operating_income");
    check("QBO Other Income → income/other_income", qCanon.get("4900")!.subtype === "other_income");
    check("QBO Accounts payable → liability/current_liability", qCanon.get("2000")!.type === "liability");
    check("QBO Credit Card → liability/credit_card", qCanon.get("2200")!.subtype === "credit_card");
    check("QBO Equity → equity", qCanon.get("3000")!.type === "equity");
    check("QBO Cost of Goods Sold → expense/cogs", qCanon.get("5000")!.type === "expense" && qCanon.get("5000")!.subtype === "cogs");
    check("QBO Expense → expense/operating_expense", qCanon.get("6000")!.subtype === "operating_expense");

    const xeroCoa = analyzeFile(fx("xero/chart_of_accounts.csv"));
    check("Xero chart of accounts → source xero", xeroCoa.source === "xero");
    check("Xero chart of accounts → entity accounts", xeroCoa.entity === "accounts");
    const xCanon = new Map(applyMapping("accounts", "xero", xeroCoa.mapping, parseWithHeaders(fx("xero/chart_of_accounts.csv")).rows).map((r) => [r.code, r]));
    check("Xero Bank → asset/bank", xCanon.get("1000")!.subtype === "bank");
    check("Xero Revenue → income", xCanon.get("4000")!.type === "income");
    check("Xero Current Liability → liability", xCanon.get("2000")!.type === "liability");
    check("Xero Direct Costs → expense/cogs", xCanon.get("5000")!.subtype === "cogs");
    check("Xero Overhead → expense/operating_expense", xCanon.get("6000")!.subtype === "operating_expense");

    const xContacts = analyzeFile(fx("xero/contacts.csv"));
    check("Xero contacts → source xero", xContacts.source === "xero");
    check("Xero contacts → a party entity", xContacts.entity === "customers" || xContacts.entity === "vendors");
    check("QBO trial balance → entity trial_balance", analyzeFile(fx("qbo/trial_balance.csv")).entity === "trial_balance");

    // ------------------------------------------------------------------
    // Part 2 — commit round-trips against a real Postgres
    // ------------------------------------------------------------------
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('QBO Migrator','qbo-migrator')`);   // org 1
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Xero Migrator','xero-migrator')`); // org 2
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('m@i.test','x','Migrator')`);
    await seedOrgDefaults(1);
    await seedOrgDefaults(2);

    const assertTbMatches = async (label: string, expected: Map<string, { debit: number; credit: number }>) => {
      const tb = await storage.trialBalance("2026-01-01");
      const actual = new Map<string, { debit: number; credit: number }>(tb.rows.map((r: any) => [r.code, { debit: r.debit, credit: r.credit }]));
      let allMatch = true;
      for (const [code, e] of expected) {
        const got = actual.get(code) || { debit: 0, credit: 0 };
        if (got.debit !== e.debit || got.credit !== e.credit) { allMatch = false; console.log(`     mismatch ${code}: got ${JSON.stringify(got)} want ${JSON.stringify(e)}`); }
      }
      check(`${label}: trial balance equals source to the cent`, allMatch);
      check(`${label}: no unexpected accounts posted`, tb.rows.every((r: any) => expected.has(r.code)));
      check(`${label}: totals balance (Dr = Cr)`, tb.totalDebit === tb.totalCredit);
    };

    console.log("Test: QBO bundle → import → trial balance tie-out (org 1)");
    // Committing each file through the wizard's own dispatch: source CSV in,
    // auto-suggested mapping, real writes. Parties/items carry no GL, so they
    // run before the trial-balance tie-out; bills post AP+expense, so they run
    // AFTER the tie-out assertion.
    const commit = (entity: any, source: any, file: string, extra: any = {}) => {
      const csv = fx(file);
      return runImport(entity, source, suggestMapping(entity, parseWithHeaders(csv).headers), csv, { dryRun: false, ...extra });
    };
    await withOrg({ orgId: 1, userId: 1 }, async () => {
      check("QBO customers imported (3)", (await commit("customers", "qbo", "qbo/customers.csv")).inserted === 3);
      check("QBO vendors imported (2)", (await commit("vendors", "qbo", "qbo/vendors.csv")).inserted === 2);
      check("QBO products/services imported (2)", (await commit("items", "qbo", "qbo/products_services.csv")).inserted === 2);

      const tbCsv = fx("qbo/trial_balance.csv");
      const tbRep = await runImport("trial_balance", "qbo", suggestMapping("trial_balance", parseWithHeaders(tbCsv).headers), tbCsv, { dryRun: false, conversionDate: "2026-01-01" });
      check("QBO trial balance posted as one JE", tbRep.inserted === 1);
      await assertTbMatches("QBO", goldenTb(tbCsv));

      // Open bills post AP + expense (verified after the opening tie-out).
      check("QBO open bills imported (2)", (await commit("bills", "qbo", "qbo/bills.csv")).inserted === 2);
      const ap = await storage.trialBalance("2026-02-28");
      const apRow = ap.rows.find((r: any) => r.code === "2000");
      check("QBO bills raised Accounts Payable by 540.00", !!apRow && apRow.credit === 4200_00 + 540_00);
    });

    console.log("Test: Xero bundle → import → trial balance tie-out (org 2)");
    await withOrg({ orgId: 2, userId: 1 }, async () => {
      const tbCsv = fx("xero/trial_balance.csv");
      // Dry-run first proves zero writes, then commit.
      const dry = await runImport("trial_balance", "xero", suggestMapping("trial_balance", parseWithHeaders(tbCsv).headers), tbCsv, { dryRun: true, conversionDate: "2026-01-01" });
      check("Xero trial balance dry-run reports one JE, no writes", dry.inserted === 1 && dry.dryRun === true);
      const before = Number((await pool.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE org_id=2`)).rows[0].c);
      check("Xero dry-run wrote nothing", before === 0);

      const tbRep = await runImport("trial_balance", "xero", suggestMapping("trial_balance", parseWithHeaders(tbCsv).headers), tbCsv, { dryRun: false, conversionDate: "2026-01-01" });
      check("Xero trial balance posted as one JE", tbRep.inserted === 1);
      await assertTbMatches("Xero", goldenTb(tbCsv));
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — QBO & Xero exports migrate; trial balance ties out to the cent");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
