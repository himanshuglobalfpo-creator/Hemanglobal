// ============================================================================
// CONCURRENCY REGRESSION TEST — applyCreditNote over-application race
// ============================================================================
// Bug (pre-fix): every write inside creditNoteService's db.transaction(...)
// blocks used the OUTER `db` handle, so the writes autocommitted on separate
// pool connections OUTSIDE the transaction, and the note/invoice were read
// (and remainingCredit checked) BEFORE the transaction with no lock. Two
// simultaneous applies both saw the same stale remainingCredit, both passed
// the check, and both wrote — applying MORE than the note's total.
//
// Fix under test:
//   1. All writes use the `tx` handle (true single transaction).
//   2. Note and invoice are read INSIDE the tx with SELECT ... FOR UPDATE
//      (fixed lock order: note → invoice).
//   3. remainingCredit is checked AFTER the lock is held, so the loser of the
//      race re-reads the winner's committed state and is rejected.
//
// This is a REAL-DATABASE test: it needs Postgres because the guarantee under
// test IS Postgres row locking. It uses, in order of preference:
//   a) $DATABASE_URL if already set (CI-provided database — MUST be throwaway;
//      the test writes freely), or
//   b) a temporary embedded-postgres instance (devDependency), fully deleted
//      afterwards.
//
// Run: tsx tests/credit_note_apply_concurrency_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  // --------------------------------------------------------------------------
  // 1. Database bootstrap — BEFORE importing server/storage (it reads the env
  //    at module load).
  // --------------------------------------------------------------------------
  let shutdown: () => Promise<void> = async () => {};
  if (!process.env.DATABASE_URL) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = (await import("embedded-postgres")).default;
    } catch {
      console.error(
        "This test needs a real Postgres (it exercises SELECT ... FOR UPDATE).\n" +
        "Either set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`."
      );
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: "password",
      port: 55439,
      persistent: false,
      // Some CI containers run as root; Postgres refuses to. This makes
      // embedded-postgres create and switch to an unprivileged user.
      createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_concurrency_test");
    process.env.DATABASE_URL =
      "postgresql://postgres:password@localhost:55439/ledgerlite_concurrency_test";
    shutdown = async () => {
      await epg.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    };
  }

  try {
    const { pool, runMigrations } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    await runMigrations();
    const noteSvc = await import("../server/creditNoteService");

    // ------------------------------------------------------------------------
    // 2. Seed: org 1, user 1, minimal chart of accounts, customer, invoices.
    //    Raw SQL keeps the fixture independent of higher-level create flows.
    // ------------------------------------------------------------------------
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Test Org', 'test-org')`);
    await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ('t@t.test', 'x', 'Tester')`
    );
    const acctIds: Record<string, number> = {};
    for (const [code, name, type, subtype] of [
      ["1100", "Accounts Receivable", "asset", "current_asset"],
      ["4000", "Sales Revenue", "income", "operating_income"],
    ] as const) {
      const r = await pool.query(
        `INSERT INTO accounts (org_id, code, name, type, subtype) VALUES (1,$1,$2,$3,$4) RETURNING id`,
        [code, name, type, subtype]
      );
      acctIds[code] = r.rows[0].id;
    }
    const customerId = (
      await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Acme Corp') RETURNING id`)
    ).rows[0].id;
    async function seedInvoice(number: string, totalCents: number): Promise<number> {
      const r = await pool.query(
        `INSERT INTO invoices (org_id, number, customer_id, date, due_date, status, subtotal, tax, total, amount_paid)
         VALUES (1,$1,$2,'2026-07-01','2026-07-31','open',$3,0,$3,0) RETURNING id`,
        [number, customerId, totalCents]
      );
      return r.rows[0].id;
    }
    const ctx = { orgId: 1, userId: 1 };

    // ------------------------------------------------------------------------
    // 3. THE RACE — a $600 credit note, two SIMULTANEOUS $400 applies against
    //    a $1,000 invoice. The invoice can absorb both; the NOTE cannot.
    //    Pre-fix: both callers read remainingCredit=600 with no lock, both
    //    passed the check, both wrote → $800 applied of a $600 note.
    //    Post-fix: FOR UPDATE serializes them; the loser re-reads $200
    //    remaining and is rejected. Total applied can NEVER exceed the total.
    // ------------------------------------------------------------------------
    console.log("\n[1] Two simultaneous $400 applies of a $600 credit note");
    const invoiceId = await seedInvoice("INV-9001", 100_000);
    const note = await withOrg(ctx, () =>
      noteSvc.createCreditNote({
        customerId,
        date: "2026-07-05",
        reason: "Goods returned",
        taxRate: 0,
        lines: [{ description: "Returned widgets", quantity: 6, rate: 100, revenueAccountId: acctIds["4000"] }],
      })
    );
    check("fixture: note total is $600.00", note.total === 60_000, String(note.total));

    const results = await Promise.allSettled([
      withOrg(ctx, () => noteSvc.applyCreditNote(note.id, invoiceId, 400)), // dollars at the API boundary
      withOrg(ctx, () => noteSvc.applyCreditNote(note.id, invoiceId, 400)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    check("exactly ONE apply succeeds", ok.length === 1, `${ok.length} succeeded`);
    check(
      "the loser is rejected with the remaining-credit business error",
      failed.length === 1 && /has only .* remaining/.test(String(failed[0]?.reason?.message)),
      failed.map((f) => String(f.reason?.message)).join(" | ")
    );

    let row = (await pool.query(
      `SELECT total, applied_amount, remaining_credit, status FROM credit_notes WHERE id = $1`, [note.id]
    )).rows[0];
    let appsSum = Number((await pool.query(
      `SELECT COALESCE(SUM(amount_applied),0) AS s FROM credit_note_applications WHERE credit_note_id = $1`, [note.id]
    )).rows[0].s);
    let invPaid = Number((await pool.query(
      `SELECT amount_paid FROM invoices WHERE id = $1`, [invoiceId]
    )).rows[0].amount_paid);

    check("INVARIANT: total applied never exceeds the note total", row.applied_amount <= row.total,
      `applied=${row.applied_amount} total=${row.total}`);
    check("applied_amount is exactly one $400 apply", row.applied_amount === 40_000, String(row.applied_amount));
    check("remaining_credit = total - applied ($200)", row.remaining_credit === 20_000, String(row.remaining_credit));
    check("application rows sum to applied_amount", appsSum === row.applied_amount, `sum=${appsSum}`);
    check("invoice amount_paid matches ($400)", invPaid === 40_000, String(invPaid));
    check("note status remains 'issued' (not exhausted)", row.status === "issued", row.status);

    // The loser must ALSO leave no partial residue: no orphan application row,
    // no invoice bump — the whole point of running the writes in ONE tx.
    const appCount = Number((await pool.query(
      `SELECT COUNT(*) AS c FROM credit_note_applications WHERE credit_note_id = $1`, [note.id]
    )).rows[0].c);
    check("rejected apply left NO orphan application row", appCount === 1, String(appCount));

    // ------------------------------------------------------------------------
    // 4. The survivor of the race can still apply the true remainder.
    // ------------------------------------------------------------------------
    console.log("\n[2] Applying the remaining $200 afterwards succeeds and exhausts the note");
    const final = await withOrg(ctx, () => noteSvc.applyCreditNote(note.id, invoiceId, 200));
    check("remainingCredit reaches exactly $0.00", final.creditNote.remainingCredit === 0);
    check("status flips to 'applied'", final.creditNote.status === "applied", final.creditNote.status);

    // ------------------------------------------------------------------------
    // 5. STRESS — 10 simultaneous $100 applies of a $500 note. Exactly 5 can
    //    fit; serialization must admit precisely 5 regardless of arrival order.
    // ------------------------------------------------------------------------
    console.log("\n[3] Stress: 10 simultaneous $100 applies of a $500 note → exactly 5 admitted");
    const invoice2 = await seedInvoice("INV-9002", 1_000_000);
    const note2 = await withOrg(ctx, () =>
      noteSvc.createCreditNote({
        customerId,
        date: "2026-07-06",
        reason: "Pricing error",
        taxRate: 0,
        lines: [{ description: "Overbilled", quantity: 5, rate: 100, revenueAccountId: acctIds["4000"] }],
      })
    );
    const burst = await Promise.allSettled(
      Array.from({ length: 10 }, () => withOrg(ctx, () => noteSvc.applyCreditNote(note2.id, invoice2, 100)))
    );
    const admitted = burst.filter((r) => r.status === "fulfilled").length;
    row = (await pool.query(
      `SELECT total, applied_amount, remaining_credit, status FROM credit_notes WHERE id = $1`, [note2.id]
    )).rows[0];
    appsSum = Number((await pool.query(
      `SELECT COALESCE(SUM(amount_applied),0) AS s FROM credit_note_applications WHERE credit_note_id = $1`, [note2.id]
    )).rows[0].s);
    invPaid = Number((await pool.query(
      `SELECT amount_paid FROM invoices WHERE id = $1`, [invoice2]
    )).rows[0].amount_paid);

    check("exactly 5 of 10 concurrent applies admitted", admitted === 5, String(admitted));
    check("INVARIANT: applied_amount === note total, never above", row.applied_amount === 50_000, String(row.applied_amount));
    check("remaining_credit is exactly 0", row.remaining_credit === 0, String(row.remaining_credit));
    check("application rows sum to note total", appsSum === 50_000, String(appsSum));
    check("invoice amount_paid equals note total", invPaid === 50_000, String(invPaid));
    check("note status is 'applied'", row.status === "applied", row.status);
    check(
      "every rejected apply failed with the remaining-credit error (not a deadlock/DB error)",
      burst.filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .every((r) => /has only .* remaining/.test(String(r.reason?.message)))
    );

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll credit-note apply concurrency tests passed (real Postgres, real FOR UPDATE).");
}

main().catch(async (e) => { console.error(e); process.exit(1); });
