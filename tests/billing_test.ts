// ============================================================================
// SUBSCRIPTION BILLING (P4.1) — trial/read-only, dunning, entitlements, seats
// ============================================================================
// Graded invariants (all driven WITHOUT Stripe — the state machine is testable
// on its own; Stripe only signs webhooks and hosts checkout/portal):
//   1. Trial expiry → read-only.
//   2. Failed-payment dunning: past_due + 7-day grace, then read-only.
//   3. Entitlement denial → 402 with plan info.
//   4. Seat limit blocks the (N+1)th member invite.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };
function runMw(mw: any, req: any): Promise<{ code: number; body: any; called: boolean }> {
  return new Promise((resolve) => {
    let code = 0; let body: any = null; let called = false;
    const res: any = { status(c: number) { code = c; return this; }, json(b: any) { body = b; resolve({ code, body, called }); return this; } };
    Promise.resolve(mw(req, res, () => { called = true; resolve({ code, body, called }); }));
  });
}

(async () => {
  const { pool, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("billing");
  try {
    const billing = await import("../server/billing");
    const orgRow = async (id: number) => (await pool.query(`SELECT * FROM organizations WHERE id=$1`, [id])).rows[0];

    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Payco','payco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('a@a.test','x','A')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('b@b.test','x','B')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('c@c.test','x','C')`);
    await seedOrgDefaults(1);

    console.log("Test: signup trial → not read-only until it expires");
    await billing.startTrial(1);
    let org = await orgRow(1);
    check("trial started (trialing, 14-day window, 3 seats)", org.billing_status === "trialing" && !!org.trial_ends_at && org.seat_limit === 3);
    check("active trial is NOT read-only", billing.effectiveBillingState(org).readOnly === false);
    // Force the trial into the past.
    await pool.query(`UPDATE organizations SET trial_ends_at=$1 WHERE id=1`, [new Date(Date.now() - 86400_000).toISOString()]);
    org = await orgRow(1);
    const expired = billing.effectiveBillingState(org);
    check("expired trial → read-only (reason trial_expired)", expired.readOnly === true && expired.reason === "trial_expired");

    console.log("Test: failed-payment dunning path");
    await billing.applyPlatformEvent(1, "customer.subscription.updated", process.env.PLATFORM_STRIPE_PRICE_PLUS); // become active first
    await billing.applyPlatformEvent(1, "invoice.payment_failed");
    org = await orgRow(1);
    check("payment_failed → past_due with a grace window", org.billing_status === "past_due" && !!org.grace_until);
    check("within grace is NOT read-only", billing.effectiveBillingState(org).readOnly === false);
    // Elapse the grace window.
    await pool.query(`UPDATE organizations SET grace_until=$1 WHERE id=1`, [new Date(Date.now() - 3600_000).toISOString()]);
    const dunned = billing.effectiveBillingState(await orgRow(1));
    check("past grace → read-only (reason payment_failed)", dunned.readOnly === true && dunned.reason === "payment_failed");
    // Recovery.
    await billing.applyPlatformEvent(1, "invoice.payment_succeeded");
    check("payment recovers → active, not read-only", billing.effectiveBillingState(await orgRow(1)).readOnly === false);

    console.log("Test: cancellation → read-only");
    await billing.applyPlatformEvent(1, "customer.subscription.deleted");
    const canceled = billing.effectiveBillingState(await orgRow(1));
    check("canceled subscription → read-only", canceled.readOnly === true && canceled.reason === "canceled");

    console.log("Test: entitlement denial → 402 with plan info");
    const payrollGate = billing.requireEntitlement("payroll");
    const starterDenied = await runMw(payrollGate, { org: { plan: "starter", billingStatus: "active" } });
    check("starter denied payroll → 402", starterDenied.code === 402);
    check("402 body carries code + plan + required plans", starterDenied.body?.code === "ENTITLEMENT_REQUIRED" && starterDenied.body?.plan === "starter" && starterDenied.body?.requiredPlans?.includes("advanced"));
    const trialAllowed = await runMw(payrollGate, { org: { plan: "trial", billingStatus: "trialing" } });
    check("trial allowed payroll → next()", trialAllowed.called === true);
    const plusDeniedPayroll = await runMw(payrollGate, { org: { plan: "plus", billingStatus: "active" } });
    check("plus (no payroll) denied → 402", plusDeniedPayroll.code === 402);
    const multiGate = billing.requireEntitlement("multiCurrency");
    check("plus allowed multiCurrency → next()", (await runMw(multiGate, { org: { plan: "plus", billingStatus: "active" } })).called === true);

    console.log("Test: seat limit blocks the (N+1)th invite");
    await pool.query(`UPDATE organizations SET seat_limit=2, billing_status='active', plan='starter' WHERE id=1`);
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (1,1,'owner')`);
    org = await orgRow(1);
    check("1 of 2 seats used → invite allowed", await billing.seatUsage(1) === 1);
    await (async () => { let ok = true; try { await billing.assertSeatAvailable(org); } catch { ok = false; } check("under the limit → assertSeatAvailable passes", ok); })();
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (2,1,'admin')`); // now 2/2
    let blocked = false; let code = 0;
    try { await billing.assertSeatAvailable(await orgRow(1)); } catch (e: any) { blocked = true; code = e.status; }
    check("at the limit → (N+1)th invite blocked with 402", blocked && code === 402);

    void withOrg;
    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — trial→read-only, dunning grace, entitlement 402, seat limit");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
