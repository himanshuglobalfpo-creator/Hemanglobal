// ============================================================================
// REGRESSION TEST — Stripe clearing account is an explicit org setting
// ============================================================================
// Old behavior: the checkout.session.completed webhook posted the payment to
// the FIRST bank-subtype account it found in the chart of accounts. With more
// than one bank account, real money silently booked to whichever sorted first.
//
// New behavior under test (server/stripe.ts getConfiguredClearingAccount):
//   1. UNSET setting → throws the exact "Stripe clearing account not
//      configured" error. The webhook does NOT guess.
//   2. Setting pointing at a non-bank account → rejected with a clear error.
//   3. Setting pointing at ANOTHER ORG's bank account → rejected (tenant
//      isolation — never book org A's money into org B's account).
//   4. Setting pointing at a deleted/nonexistent account → rejected.
//   5. Correctly configured → returns exactly the chosen account, even when
//      another bank account sorts first (the old guess would pick the wrong
//      one — asserted explicitly).
//   6. The FK is ON DELETE RESTRICT: the configured clearing account cannot
//      be deleted out from under live payments.
//
// Real-Postgres test (same harness as credit_note_apply_concurrency_test):
// uses $DATABASE_URL if set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/stripe_clearing_account_test.ts
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
      console.error(
        "This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`."
      );
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: "password",
      port: 55440,
      persistent: false,
      createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_stripe_test");
    process.env.DATABASE_URL =
      "postgresql://postgres:password@localhost:55440/ledgerlite_stripe_test";
    shutdown = async () => {
      await epg.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    };
  }

  try {
    const { pool, runMigrations } = await import("../server/storage");
    await runMigrations();
    const { getConfiguredClearingAccount, CLEARING_ACCOUNT_NOT_CONFIGURED } = await import("../server/stripe");

    // ------------------------------------------------------------------------
    // Fixture: two orgs. Org 1 has TWO bank accounts (the trap for the old
    // "first bank subtype" guess) plus a non-bank asset and an income account.
    // ------------------------------------------------------------------------
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Org One','org-one'), ('Org Two','org-two')`);
    async function seedAccount(orgId: number, code: string, name: string, type: string, subtype: string) {
      return (await pool.query(
        `INSERT INTO accounts (org_id, code, name, type, subtype) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, code, name, type, subtype]
      )).rows[0].id as number;
    }
    const org1FirstBank = await seedAccount(1, "1000", "Operating Checking", "asset", "bank"); // sorts first
    const org1Savings   = await seedAccount(1, "1010", "Stripe Settlement",  "asset", "bank"); // the one we WANT
    const org1Ar        = await seedAccount(1, "1100", "Accounts Receivable","asset", "current_asset");
    const org1Income    = await seedAccount(1, "4000", "Sales Revenue",      "income","operating_income");
    const org2Bank      = await seedAccount(2, "1000", "Org Two Checking",   "asset", "bank");

    // ------------------------------------------------------------------------
    console.log("\n[1] Unset setting fails loudly — the webhook must not guess");
    // ------------------------------------------------------------------------
    await expectReject(
      "unset → 'Stripe clearing account not configured'",
      () => getConfiguredClearingAccount(1),
      /^Stripe clearing account not configured/
    );
    check(
      "the exact contract message is exported and matched",
      CLEARING_ACCOUNT_NOT_CONFIGURED.startsWith("Stripe clearing account not configured")
    );

    // ------------------------------------------------------------------------
    console.log("\n[2] Invalid configurations are rejected with actionable errors");
    // ------------------------------------------------------------------------
    // Non-bank asset (AR)
    await pool.query(`UPDATE organizations SET stripe_clearing_account_id = $1 WHERE id = 1`, [org1Ar]);
    await expectReject(
      "AR account (asset/current_asset) rejected",
      () => getConfiguredClearingAccount(1),
      /must be a bank-subtype asset account/
    );
    // Income account
    await pool.query(`UPDATE organizations SET stripe_clearing_account_id = $1 WHERE id = 1`, [org1Income]);
    await expectReject(
      "income account rejected",
      () => getConfiguredClearingAccount(1),
      /must be a bank-subtype asset account/
    );
    // Another org's bank account — tenant isolation
    await pool.query(`UPDATE organizations SET stripe_clearing_account_id = $1 WHERE id = 1`, [org2Bank]);
    await expectReject(
      "another org's bank account rejected (tenant isolation)",
      () => getConfiguredClearingAccount(1),
      /does not exist in this organization/
    );
    // Nonexistent id
    await pool.query(`UPDATE organizations SET stripe_clearing_account_id = NULL WHERE id = 1`);
    // (FK prevents setting a truly nonexistent id at the DB layer:)
    let fkBlocked = false;
    try {
      await pool.query(`UPDATE organizations SET stripe_clearing_account_id = 999999 WHERE id = 1`);
    } catch (e: any) {
      fkBlocked = /foreign key/i.test(String(e?.message)) || e?.code === "23503";
    }
    check("FK blocks pointing the setting at a nonexistent account", fkBlocked);

    // ------------------------------------------------------------------------
    console.log("\n[3] Correct configuration resolves the CHOSEN account, not the first bank");
    // ------------------------------------------------------------------------
    await pool.query(`UPDATE organizations SET stripe_clearing_account_id = $1 WHERE id = 1`, [org1Savings]);
    const resolved = await getConfiguredClearingAccount(1);
    check("resolves to the configured account", resolved.id === org1Savings, `got ${resolved.id}`);
    check(
      "REGRESSION: old 'first bank subtype' guess would have picked a DIFFERENT account",
      org1FirstBank !== org1Savings && resolved.id !== org1FirstBank
    );
    check("resolved account is asset/bank", resolved.type === "asset" && resolved.subtype === "bank");

    // ------------------------------------------------------------------------
    console.log("\n[4] The configured clearing account cannot be deleted (ON DELETE RESTRICT)");
    // ------------------------------------------------------------------------
    let deleteBlocked = false;
    try {
      await pool.query(`DELETE FROM accounts WHERE id = $1`, [org1Savings]);
    } catch (e: any) {
      deleteBlocked = e?.code === "23503" || /foreign key|violates/i.test(String(e?.message));
    }
    check("delete of the live clearing account is blocked", deleteBlocked);
    // ...and after clearing the setting, delete succeeds (no dangling RESTRICT).
    await pool.query(`UPDATE organizations SET stripe_clearing_account_id = NULL WHERE id = 1`);
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [org1Savings]);
    check("after clearing the setting the account can be deleted", true);

    // ------------------------------------------------------------------------
    console.log("\n[5] Deleted-account edge: setting cleared → back to fail-loud, not fail-guess");
    // ------------------------------------------------------------------------
    await expectReject(
      "org is back to 'not configured' and still refuses to guess",
      () => getConfiguredClearingAccount(1),
      /^Stripe clearing account not configured/
    );

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Stripe clearing-account tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
