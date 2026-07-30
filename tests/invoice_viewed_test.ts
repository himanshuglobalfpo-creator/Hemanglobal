// ============================================================================
// INVOICE VIEWED TRACKING (P3.10) — first/last viewed + Sent chip
// ============================================================================
// The public share page fires POST /p/invoice/:token/viewed on load (an honest
// page view — no email pixel). This records:
//   - first_viewed_at ONCE (never moves after the first open),
//   - last_viewed_at on EVERY view.
// Sending stamps sent_at once. Together they drive the Sent → Viewed → Paid
// status chips. Postgres harness.
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("invoice_viewed");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Viewco','viewco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('v@v.test','x','Viewer')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const custId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Acme') RETURNING id`)).rows[0].id as number;
      const income = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='4000'`)).rows[0].id as number;
      const inv = await storage.createInvoice({ customerId: custId, date: "2026-02-01", dueDate: "2026-03-01", taxRate: 0, lines: [{ description: "Work", quantity: 1, rate: 100, incomeAccountId: income }] } as any);
      const share = await storage.createInvoiceShare(inv.id);
      const viewed = async () => (await pool.query(`SELECT first_viewed_at f, last_viewed_at l, sent_at s FROM invoices WHERE id=$1`, [inv.id])).rows[0];

      console.log("Test: unviewed invoice has no timestamps");
      let v = await viewed();
      check("first/last viewed start null", v.f === null && v.l === null && v.s === null);

      console.log("Test: first view stamps first + last");
      const ok = await storage.recordInvoiceViewed(share.token);
      check("recordInvoiceViewed found the invoice by token", ok === true);
      v = await viewed();
      check("first_viewed_at set", v.f !== null);
      check("last_viewed_at set", v.l !== null);
      const firstStamp = v.f;

      console.log("Test: subsequent views move last but NOT first");
      await sleep(5);
      await storage.recordInvoiceViewed(share.token);
      v = await viewed();
      check("first_viewed_at unchanged after re-view", v.f === firstStamp);
      check("last_viewed_at >= first_viewed_at", v.l >= v.f);

      console.log("Test: an unknown token is a safe no-op");
      check("unknown token returns false", (await storage.recordInvoiceViewed("nope-not-a-token")) === false);

      console.log("Test: sending stamps sent_at once");
      await storage.markInvoiceSent(inv.id);
      const s1 = (await viewed()).s;
      check("sent_at set on send", s1 !== null);
      await sleep(5);
      await storage.markInvoiceSent(inv.id);
      check("sent_at is stable across re-sends", (await viewed()).s === s1);

      console.log("Test: delivery status derivation (Sent → Viewed → Paid)");
      const derive = (row: any, status: string) => status === "paid" ? "paid" : row.f ? "viewed" : row.s ? "sent" : "open";
      const row = await viewed();
      check("viewed + sent + open invoice → 'viewed'", derive(row, inv.status) === "viewed");
      check("paid always wins", derive(row, "paid") === "paid");
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — first viewed stamped once, last on every view, sent stamped once");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
