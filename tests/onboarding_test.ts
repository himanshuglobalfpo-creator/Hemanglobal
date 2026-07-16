// ============================================================================
// ONBOARDING & ACTIVATION (P4.2) — funnel, checklist, presets, demo clear
// ============================================================================
// Graded invariants:
//   1. Funnel: each step's FIRST completion is recorded once (idempotent), with
//      a timestamp, in order.
//   2. Activation checklist: 5 tasks flip done via a recorded event OR real
//      data; complete=true only when all five are done.
//   3. Demo mode: seed flags the org; clear wipes transactional data back to a
//      fresh set of books (chart of accounts + settings preserved).
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("onboarding");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Onboardco','onboardco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('o@o.test','x','O')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('o2@o.test','x','O2')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      console.log("Test: funnel records first completion once (idempotent)");
      await storage.recordOnboardingEvent("profile");
      const firstTs = (await storage.listOnboardingEvents())[0].completedAt;
      await new Promise((r) => setTimeout(r, 5));
      await storage.recordOnboardingEvent("profile"); // repeat
      let events = await storage.listOnboardingEvents();
      check("repeat step does not duplicate", events.filter((e) => e.step === "profile").length === 1);
      check("first-touch timestamp preserved", events[0].completedAt === firstTs);
      await storage.recordOnboardingEvent("bank");
      events = await storage.listOnboardingEvents();
      check("two steps recorded, ordered by time", events.length === 2 && events[0].step === "profile" && events[1].step === "bank");

      console.log("Test: activation checklist flips via events OR data");
      let cl = await storage.activationChecklist();
      const doneOf = (s: string) => cl.tasks.find((t) => t.step === s)?.done;
      check("profile done (event)", doneOf("profile") === true);
      check("bank done (event)", doneOf("bank") === true);
      check("import NOT done yet", doneOf("import") === false);
      check("invite NOT done yet", doneOf("invite") === false);
      check("first_invoice NOT done yet", doneOf("first_invoice") === false);
      check("checklist not complete", cl.complete === false);

      // Complete the rest via real data + events.
      const income = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='4000'`)).rows[0].id as number;
      const cust = await storage.createCustomer({ name: "Acme", email: undefined, phone: undefined, address: undefined, notes: undefined } as any);
      await storage.createInvoice({ customerId: cust.id, date: "2026-02-01", dueDate: "2026-03-01", taxRate: 0, lines: [{ description: "Work", quantity: 1, rate: 100, incomeAccountId: income }] } as any);
      await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (1,1,'owner')`);
      await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (2,1,'admin')`);
      await storage.recordOnboardingEvent("import");
      cl = await storage.activationChecklist();
      check("first_invoice done (invoice exists)", cl.tasks.find((t) => t.step === "first_invoice")?.done === true);
      check("invite done (2 members)", cl.tasks.find((t) => t.step === "invite")?.done === true);
      check("import done (event)", cl.tasks.find((t) => t.step === "import")?.done === true);
      check("checklist now complete", cl.complete === true);

      console.log("Test: industry preset adds tailored accounts");
      const before = Number((await pool.query(`SELECT COUNT(*)::int c FROM accounts WHERE org_id=1`)).rows[0].c);
      const added = await storage.applyIndustryPreset("retail");
      check("retail preset added accounts", added === 3);
      check("account count grew", Number((await pool.query(`SELECT COUNT(*)::int c FROM accounts WHERE org_id=1`)).rows[0].c) === before + 3);
      check("Merchandise Sales account exists", Number((await pool.query(`SELECT COUNT(*)::int c FROM accounts WHERE org_id=1 AND code='4300'`)).rows[0].c) === 1);
      check("org industry recorded", (await pool.query(`SELECT industry FROM organizations WHERE id=1`)).rows[0].industry === "retail");

      console.log("Test: demo mode flag + one-click clear");
      await storage.markDemoSeeded();
      check("org flagged demo", (await storage.demoStatus()).isDemo === true);
      const acctsBefore = Number((await pool.query(`SELECT COUNT(*)::int c FROM accounts WHERE org_id=1`)).rows[0].c);
      await storage.clearDemoData();
      check("customers wiped", Number((await pool.query(`SELECT COUNT(*)::int c FROM customers WHERE org_id=1`)).rows[0].c) === 0);
      check("invoices wiped", Number((await pool.query(`SELECT COUNT(*)::int c FROM invoices WHERE org_id=1`)).rows[0].c) === 0);
      check("chart of accounts preserved", Number((await pool.query(`SELECT COUNT(*)::int c FROM accounts WHERE org_id=1`)).rows[0].c) === acctsBefore);
      check("demo flag cleared after wipe", (await storage.demoStatus()).isDemo === false);
      check("onboarding events survive the wipe", (await storage.listOnboardingEvents()).length >= 2);
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — funnel idempotent, checklist derivation, presets, demo clear");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
