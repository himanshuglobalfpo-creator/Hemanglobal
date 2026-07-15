// ============================================================================
// BATCH JOBS (P3.5) — partial failure, per-item permissions, idempotent resume
// ============================================================================
// The graded invariants:
//   1. A batch reports PER-ITEM results: a partial failure marks the good items
//      ok and the bad ones error (with a reason), never all-or-nothing.
//   2. Role is enforced PER ITEM: a void batch run without admin rights refuses
//      every item (permission error) and changes nothing.
//   3. Jobs are idempotent/resumable: re-running skips items already 'ok'.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("batch_jobs");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Batchco','batchco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('b@b.test','x','Batcher')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const custId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Acme') RETURNING id`)).rows[0].id as number;
      const income = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='4000'`)).rows[0].id as number;
      const mkInv = async (n: string) => storage.createInvoice({
        number: n, customerId: custId, date: "2026-02-01", dueDate: "2026-03-01", taxRate: 0,
        lines: [{ description: "Work", quantity: 1, rate: 100, incomeAccountId: income }],
      } as any);

      const open1 = await mkInv("INV-A");
      const open2 = await mkInv("INV-B");
      const paid = await mkInv("INV-C");
      // Mark INV-C paid so it CANNOT be voided → the partial-failure case.
      await pool.query(`UPDATE invoices SET amount_paid = total WHERE id = $1`, [paid.id]);

      console.log("Test: partial-failure reports per-item results");
      const job = await storage.runBatchJob("invoice.void", [open1.id, paid.id], { role: "owner", userId: 1 });
      const res = job.result as any[];
      const rOpen = res.find((r) => r.id === open1.id);
      const rPaid = res.find((r) => r.id === paid.id);
      check("job processed both items (progress = 2)", job.progress === 2 && job.total === 2);
      check("voidable invoice → ok", rOpen?.status === "ok");
      check("paid invoice → error with reason", rPaid?.status === "error" && /paid/i.test(rPaid.message));
      check("job status reflects partial failure", job.status === "failed");
      check("the good item actually voided", (await pool.query(`SELECT status FROM invoices WHERE id=$1`, [open1.id])).rows[0].status === "void");
      check("the bad item was NOT voided", (await pool.query(`SELECT status FROM invoices WHERE id=$1`, [paid.id])).rows[0].status !== "void");

      console.log("Test: permissions enforced per item (void needs admin/owner)");
      const denied = await storage.runBatchJob("invoice.void", [open2.id], { role: "viewer", userId: 1 });
      const dres = (denied.result as any[])[0];
      check("viewer's void item → permission error", dres.status === "error" && /permission/i.test(dres.message));
      check("no void happened under insufficient role", (await pool.query(`SELECT status FROM invoices WHERE id=$1`, [open2.id])).rows[0].status === "open");
      // A non-role-gated batch (reminder-exempt) IS allowed for the same actor.
      const rex = await storage.runBatchJob("invoice.reminder_exempt", [open2.id], { role: "viewer", userId: 1 });
      check("reminder-exempt allowed for viewer → ok", (rex.result as any[])[0].status === "ok");
      check("invoice marked reminder-exempt", (await pool.query(`SELECT reminder_exempt FROM invoices WHERE id=$1`, [open2.id])).rows[0].reminder_exempt === true);

      console.log("Test: idempotent resume skips already-completed items");
      // Re-run the SAME job over the same ids: the ok item is skipped, the paid
      // item is retried (still fails) — no item is processed twice as 'ok'.
      const resumed = await storage.runBatchJob("invoice.void", [open1.id, paid.id], { role: "owner", userId: 1, jobId: job.id });
      const rres = resumed.result as any[];
      check("resume keeps exactly one result per id (no dupes)", rres.length === 2);
      check("already-voided item stays ok on resume", rres.find((r) => r.id === open1.id)?.status === "ok");
      check("still-paid item stays error on resume", rres.find((r) => r.id === paid.id)?.status === "error");
      check("resume reused the same job row", resumed.id === job.id);

      console.log("Test: customer.statement batch produces per-customer results");
      const stmtJob = await storage.runBatchJob("customer.statement", [custId], { role: "owner", userId: 1, payload: { from: "2026-01-01", to: "2026-12-31" } });
      check("statement job completed ok", stmtJob.status === "completed" && (stmtJob.result as any[])[0].status === "ok");
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — per-item results, per-item permissions, idempotent resume");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
