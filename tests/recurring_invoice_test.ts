// ============================================================================
// RECURRING CUSTOMER INVOICES — schedule, catch-up generation, email, recording
// ============================================================================
// Proves, against a real Postgres (emails captured via SMTP_TRANSPORT=json):
//
//   (1) A recurring invoice template generates one invoice per due period via
//       the catch-up mechanism (backfilling missed periods).
//   (2) Each generated invoice is RECORDED with its originating template id.
//   (3) The customer is EMAILED when SMTP is configured (a sent share exists),
//       and the occurrence result reports emailed=true.
//   (4) autoEmail:false suppresses the email; a customer with no email address
//       is skipped gracefully — generation still succeeds either way.
//   (5) The template advances occurrencesPosted and nextRunDate.
//
// Run: tsx tests/recurring_invoice_test.ts
// ============================================================================

process.env.SMTP_TRANSPORT = "json"; // capture emails as JSON — configured, no network
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("recurring_invoice");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Recur Co', 'recur-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('r@r.test', 'x', 'Recur Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const revenue = accts.find((a) => a.code === "4000")!;
    const custWithEmail = await run(() => storage.createCustomer({ name: "Monthly Retainer Client", email: "client@example.com" } as any));
    const custNoEmail = await run(() => storage.createCustomer({ name: "No Email Client" } as any));

    const invLine = { description: "Monthly retainer", quantity: 1, rate: 500, incomeAccountId: revenue.id };

    // A: emailed (default), monthly, started 2 months ago → 3 occurrences by 7/10.
    const tplA = await run(() => storage.createRecurring({
      name: "Retainer A", kind: "invoice", frequency: "monthly", intervalCount: 1, startDate: "2026-05-10",
      payload: { customerId: custWithEmail.id, dueDateOffsetDays: 30, taxRate: 0, lines: [invLine] },
    } as any));
    // B: autoEmail:false, starts today → 1 occurrence, no email.
    const tplB = await run(() => storage.createRecurring({
      name: "Retainer B", kind: "invoice", frequency: "monthly", intervalCount: 1, startDate: "2026-07-10",
      payload: { customerId: custWithEmail.id, dueDateOffsetDays: 30, taxRate: 0, autoEmail: false, lines: [invLine] },
    } as any));
    // C: customer has no email, starts today → 1 occurrence, email skipped.
    const tplC = await run(() => storage.createRecurring({
      name: "Retainer C", kind: "invoice", frequency: "monthly", intervalCount: 1, startDate: "2026-07-10",
      payload: { customerId: custNoEmail.id, dueDateOffsetDays: 30, taxRate: 0, lines: [invLine] },
    } as any));

    // ------------------------------------------------------------------------
    console.log("\n[1] Catch-up generates + records invoices, backfilling missed periods");
    // ------------------------------------------------------------------------
    const results = await run(() => storage.runCatchUp("2026-07-10"));
    const resA = results.find((r) => r.templateId === tplA.id)!;
    check("template A generated 3 invoices (May, Jun, Jul)", resA?.posted === 3, JSON.stringify(resA?.posted));

    const invCount = async (templateId: number) =>
      (await pool.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE recurring_template_id = $1 AND org_id = 1`, [templateId])).rows[0].c as number;
    check("3 invoices recorded against template A", (await invCount(tplA.id)) === 3);
    const aInvoices = (await pool.query(`SELECT number, total, recurring_template_id FROM invoices WHERE recurring_template_id = $1 ORDER BY number`, [tplA.id])).rows;
    check("each A invoice totals $500 (50000¢) and links the template", aInvoices.every((i: any) => Number(i.total) === 50000 && i.recurring_template_id === tplA.id), JSON.stringify(aInvoices.map((i:any)=>i.number)));

    // ------------------------------------------------------------------------
    console.log("\n[2] Customer emailed when SMTP configured (a 'sent' share exists)");
    // ------------------------------------------------------------------------
    check("occurrence results report emailed=true for A", resA.results.every((r: any) => r.emailed === true), JSON.stringify(resA.results));
    const shareCount = async (templateId: number) =>
      (await pool.query(`SELECT COUNT(*)::int AS c FROM invoice_shares s JOIN invoices i ON i.id = s.invoice_id WHERE i.recurring_template_id = $1`, [templateId])).rows[0].c as number;
    check("3 shares created for A's invoices", (await shareCount(tplA.id)) === 3, String(await shareCount(tplA.id)));
    const aSent = (await pool.query(`SELECT DISTINCT email_status FROM invoice_shares s JOIN invoices i ON i.id = s.invoice_id WHERE i.recurring_template_id = $1`, [tplA.id])).rows.map((r: any) => r.email_status);
    check("A's shares are marked email_status='sent'", aSent.length === 1 && aSent[0] === "sent", JSON.stringify(aSent));

    // ------------------------------------------------------------------------
    console.log("\n[3] autoEmail:false and no-email customer both generate WITHOUT emailing");
    // ------------------------------------------------------------------------
    check("template B generated 1 invoice", (await invCount(tplB.id)) === 1);
    check("template B sent NO email (autoEmail:false)", (await shareCount(tplB.id)) === 0);
    const resB = results.find((r) => r.templateId === tplB.id)!;
    check("B occurrence reports emailed=false", resB.results[0].emailed === false);

    check("template C generated 1 invoice", (await invCount(tplC.id)) === 1);
    check("template C sent NO email (customer has no address)", (await shareCount(tplC.id)) === 0);

    // ------------------------------------------------------------------------
    console.log("\n[4] Template A advanced its schedule");
    // ------------------------------------------------------------------------
    const afterA = (await run(() => storage.getRecurring(tplA.id)))!;
    check("A occurrencesPosted = 3", afterA.occurrencesPosted === 3, String(afterA.occurrencesPosted));
    check("A nextRunDate advanced to 2026-08-10", afterA.nextRunDate === "2026-08-10", afterA.nextRunDate);

    // Re-running catch-up on the same day is idempotent (nothing new due).
    const again = await run(() => storage.runCatchUp("2026-07-10"));
    check("re-running catch-up generates nothing new", !again.some((r) => [tplA.id, tplB.id, tplC.id].includes(r.templateId)), JSON.stringify(again.map((r) => r.templateId)));

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} recurring-invoice check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll recurring customer invoice tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
