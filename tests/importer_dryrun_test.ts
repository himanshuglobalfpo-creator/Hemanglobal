// Importer dry-run: validates + reports WITHOUT writing. Runs against a live
// Postgres inside an org context, asserts row counts unchanged.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL
// if set (must be throwaway), else embedded-postgres.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  let shutdown: () => Promise<void> = async () => {};
  if (!process.env.DATABASE_URL) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = (await import("embedded-postgres")).default;
    } catch {
      console.error("This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`.");
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-imp-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "postgres", password: "password", port: 55446,
      persistent: false, createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_importer_test");
    process.env.DATABASE_URL = "postgresql://postgres:password@localhost:55446/ledgerlite_importer_test";
    shutdown = async () => { await epg.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  }

  try {
    const { pool, runMigrations, seedOrgDefaults } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    const { importCustomers, importOpeningBalances } = await import("../server/importers");
    await runMigrations();
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Import Co', 'import-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('imp@i.test', 'x', 'Import Tester')`);
    await seedOrgDefaults(1);

    console.log("Test: importer dry-run (no writes) + opening-balance imbalance");
    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const before = Number((await pool.query(`SELECT COUNT(*)::int AS c FROM customers WHERE org_id=1`)).rows[0].c);
      const NL = String.fromCharCode(10);
      const csv = ["name,email", "DryRun Alpha,a@x.test", "DryRun Beta,b@x.test", "DryRun Alpha,dupe@x.test"].join(NL) + NL;
      const rep = await importCustomers(csv, true); // dryRun
      check("dry-run reports 2 insertable", rep.inserted === 2);
      check("dry-run reports 1 dup skipped", rep.skipped === 1);
      const after = Number((await pool.query(`SELECT COUNT(*)::int AS c FROM customers WHERE org_id=1`)).rows[0].c);
      check("dry-run wrote NOTHING", before === after);

      // Opening balances that don't balance → rejected with exact difference.
      const acct = (await pool.query(`SELECT code FROM accounts WHERE org_id=1 LIMIT 2`)).rows;
      const ob = ["account_code,debit,credit", `${acct[0].code},100.00,`, `${acct[1].code},,90.00`].join(NL) + NL;
      const obRep = await importOpeningBalances(ob, "2026-01-01", true);
      const msg = obRep.errors.map((e: any) => e.message).join(" ");
      check("imbalance rejected", obRep.errors.length > 0);
      check("message states 10.00 difference", msg.includes("10.00"));
    });

    await pool.end();
  } finally {
    await shutdown();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — dry-run writes nothing; imbalance reports exact difference");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
