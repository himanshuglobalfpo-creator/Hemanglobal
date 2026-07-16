// ============================================================================
// TRUST & LEGAL (P4.3) — ToS acceptance, org deletion + retention hold
// ============================================================================
// Graded invariants:
//   1. Deletion lifecycle: request soft-flags a 7-day grace; the purge is a
//      no-op before the grace and hard-purges after it.
//   2. Retention: a financial-records hold EXCLUDES the audit log and
//      closed-period journal entries from the purge; without the hold the org
//      row itself is removed.
//   3. ToS acceptance is recorded (version + timestamp). Export produces a
//      manifest of the org's data.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };
const cnt = async (pool: any, sql: string, p: any[] = []) => Number((await pool.query(sql, p)).rows[0].c);

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("trust_legal");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Holdco','holdco')`);   // 1: hold ON (default)
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Nohold Inc','nohold')`); // 2: hold OFF
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('t@t.test','x','T')`);
    await seedOrgDefaults(1);
    await seedOrgDefaults(2);

    console.log("Test: ToS acceptance recorded on the user");
    await storage.recordTosAcceptance(1, "2026-01-01");
    const u = (await pool.query(`SELECT tos_accepted_version v, tos_accepted_at a FROM users WHERE id=1`)).rows[0];
    check("ToS version + timestamp stored", u.v === "2026-01-01" && !!u.a);

    // Org 1 data: a CLOSED-period JE (posted before the lock), an OPEN JE, a
    // customer + invoice (open), and audit rows from all of it.
    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const cash = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='1000'`)).rows[0].id as number;
      const income = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='4000'`)).rows[0].id as number;
      await storage.postJournalEntry({ date: "2026-01-15", memo: "closed", reference: "C", source: "manual", lines: [{ accountId: cash, debit: 10000, credit: 0 }, { accountId: income, debit: 0, credit: 10000 }] } as any);
      await pool.query(`INSERT INTO period_locks (org_id, lock_date) VALUES (1,'2026-01-31')`);
      await storage.postJournalEntry({ date: "2026-06-15", memo: "open", reference: "O", source: "manual", lines: [{ accountId: cash, debit: 5000, credit: 0 }, { accountId: income, debit: 0, credit: 5000 }] } as any);
      const cust = await storage.createCustomer({ name: "Acme", email: undefined, phone: undefined, address: undefined, notes: undefined } as any);
      await storage.createInvoice({ customerId: cust.id, date: "2026-06-20", dueDate: "2026-07-20", taxRate: 0, lines: [{ description: "Work", quantity: 1, rate: 100, incomeAccountId: income }] } as any);

      console.log("Test: data export manifest");
      const exp = await storage.exportOrgData();
      check("export lists the org's tables with counts", exp.tables.customers === 1 && exp.tables.invoices === 1 && exp.tables.accounts > 0);
    });

    const closedBefore = await cnt(pool, `SELECT COUNT(*)::int c FROM journal_entries WHERE org_id=1 AND date <= '2026-01-31'`);
    const auditBefore = await cnt(pool, `SELECT COUNT(*)::int c FROM audit_log WHERE org_id=1`);
    check("org 1 has a closed-period JE and audit rows", closedBefore >= 1 && auditBefore >= 1);

    console.log("Test: deletion request → 7-day grace, purge is a no-op before it");
    const { scheduledAt } = await storage.requestOrgDeletion(1);
    check("deletion scheduled ~7 days out", new Date(scheduledAt).getTime() > Date.now() + 6 * 86400_000);
    const early = await storage.purgeDueOrgDeletions(new Date().toISOString());
    check("purge before grace does nothing", early.length === 0 && (await cnt(pool, `SELECT COUNT(*)::int c FROM customers WHERE org_id=1`)) === 1);

    console.log("Test: after grace, purge honors the financial-records hold");
    const future = new Date(Date.now() + 8 * 86400_000).toISOString();
    const purged1 = await storage.purgeDueOrgDeletions(future);
    check("org 1 purged (with hold)", purged1.some((p) => p.orgId === 1 && p.hold === true));
    check("customers wiped", (await cnt(pool, `SELECT COUNT(*)::int c FROM customers WHERE org_id=1`)) === 0);
    check("invoices wiped", (await cnt(pool, `SELECT COUNT(*)::int c FROM invoices WHERE org_id=1`)) === 0);
    check("OPEN-period JEs wiped", (await cnt(pool, `SELECT COUNT(*)::int c FROM journal_entries WHERE org_id=1 AND date > '2026-01-31'`)) === 0);
    check("CLOSED-period JEs RETAINED under hold", (await cnt(pool, `SELECT COUNT(*)::int c FROM journal_entries WHERE org_id=1 AND date <= '2026-01-31'`)) === closedBefore);
    check("audit log RETAINED under hold", (await cnt(pool, `SELECT COUNT(*)::int c FROM audit_log WHERE org_id=1`)) >= auditBefore);
    check("org shell kept with purged_at set", (await cnt(pool, `SELECT COUNT(*)::int c FROM organizations WHERE id=1 AND purged_at IS NOT NULL`)) === 1);

    console.log("Test: without the hold, the org row itself is removed");
    await pool.query(`UPDATE organizations SET financial_records_hold=false WHERE id=2`);
    await withOrg({ orgId: 2, userId: 1 }, async () => {
      await storage.postJournalEntry({ date: "2026-03-01", memo: "x", reference: "X", source: "manual", lines: [{ accountId: (await pool.query(`SELECT id FROM accounts WHERE org_id=2 AND code='1000'`)).rows[0].id, debit: 100, credit: 0 }, { accountId: (await pool.query(`SELECT id FROM accounts WHERE org_id=2 AND code='4000'`)).rows[0].id, debit: 0, credit: 100 }] } as any);
    });
    await storage.requestOrgDeletion(2);
    const purged2 = await storage.purgeDueOrgDeletions(future);
    check("org 2 purged (no hold)", purged2.some((p) => p.orgId === 2 && p.hold === false));
    check("org 2 row hard-deleted", (await cnt(pool, `SELECT COUNT(*)::int c FROM organizations WHERE id=2`)) === 0);
    check("org 2 journal entries + audit gone", (await cnt(pool, `SELECT COUNT(*)::int c FROM journal_entries WHERE org_id=2`)) === 0 && (await cnt(pool, `SELECT COUNT(*)::int c FROM audit_log WHERE org_id=2`)) === 0);

    console.log("Test: cancel clears a pending deletion");
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Cancelco','cancelco')`); // id 3
    await storage.requestOrgDeletion(3);
    await storage.cancelOrgDeletion(3);
    check("canceled deletion is not due", (await storage.purgeDueOrgDeletions(future)).every((p) => p.orgId !== 3));
    check("org 3 schedule cleared", (await cnt(pool, `SELECT COUNT(*)::int c FROM organizations WHERE id=3 AND deletion_scheduled_at IS NULL`)) === 1);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — 7-day grace, retention hold preserves audit + closed JEs, hard-delete without hold");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
