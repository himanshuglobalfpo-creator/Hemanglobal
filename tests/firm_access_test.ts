// ============================================================================
// FIRM LAYER — access resolution, revocation, and the firm-only guard
// ============================================================================
// The firm layer's security rests on ONE function that runs on every request
// (server/auth.ts resolveOrgAccess, called by attachSession). These tests pin
// its behavior plus the /api/firm/* guard:
//   1. A firm member sees EXACTLY the clients granted to their firm.
//   2. Revoking a grant cuts access on the very next request (resolve → null),
//      even though the firm user's session is untouched.
//   3. Non-firm users (and firm viewers) cannot reach firm-only endpoints.
//   4. Only an ACTIVE grant from an is_firm org, held by an accountant/admin/
//      owner, confers access — pending/revoked grants and non-firm orgs do not.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

(async () => {
  const { pool, cleanup } = await setupTestDb("firm_access");
  try {
    const auth = await import("../server/auth");
    const firm = await import("../server/firm");

    // ---- Orgs (1 firm, 2 clients, plus a non-firm org that will hold a grant) ----
    await pool.query(`INSERT INTO organizations (name, slug, is_firm) VALUES ('Beancounters LLP','beancounters',true)`);   // 1 firm
    await pool.query(`INSERT INTO organizations (name, slug, is_firm) VALUES ('Acme Client','acme',false)`);               // 2 client A
    await pool.query(`INSERT INTO organizations (name, slug, is_firm) VALUES ('Globex Client','globex',false)`);           // 3 client B
    await pool.query(`INSERT INTO organizations (name, slug, is_firm) VALUES ('Solo Biz','solo',false)`);                  // 4 unrelated
    await pool.query(`INSERT INTO organizations (name, slug, is_firm) VALUES ('Not A Firm','notfirm',false)`);             // 5 non-firm "firm"

    // ---- Users ----
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('acct@firm.test','x','Firm Accountant')`);    // 1
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('viewer@firm.test','x','Firm Viewer')`);      // 2
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('owner@acme.test','x','Acme Owner')`);        // 3
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('nobody@out.test','x','Outsider')`);          // 4
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('u5@x.test','x','Pseudo Firm User')`);        // 5

    // ---- Memberships ----
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (1,1,'accountant')`); // firm accountant
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (2,1,'viewer')`);     // firm viewer
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (3,2,'owner')`);      // acme owner
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (4,4,'owner')`);      // outsider owns solo
    await pool.query(`INSERT INTO org_memberships (user_id, org_id, role) VALUES (5,5,'accountant')`); // pseudo-firm accountant

    const grant = (firmId: number, clientId: number | null, status: string, token: string) =>
      pool.query(
        `INSERT INTO firm_client_access (firm_org_id, client_org_id, granted_role, status, invite_email, invite_token, invited_by_user_id, approved_at)
         VALUES ($1,$2,'accountant',$3,'owner@acme.test',$4,1, CASE WHEN $3='active' THEN now() ELSE NULL END)`,
        [firmId, clientId, status, token]
      );

    console.log("Test: resolveOrgAccess — the per-request access authority");
    await grant(1, 2, "active", "tok-a"); // firm 1 → client A (2) ACTIVE

    const a = await auth.resolveOrgAccess(1, 2);
    check("firm accountant reaches granted client (viaFirm, role accountant)", !!a && a.viaFirm === true && a.role === "accountant" && a.firmOrgId === 1);
    check("firm accountant does NOT reach a non-granted client", (await auth.resolveOrgAccess(1, 3)) === null);
    const own = await auth.resolveOrgAccess(1, 1);
    check("firm accountant reaches own firm via direct membership (not viaFirm)", !!own && own.viaFirm === false && own.role === "accountant");
    check("firm VIEWER does not inherit client access", (await auth.resolveOrgAccess(2, 2)) === null);
    check("outsider reaches neither firm nor client", (await auth.resolveOrgAccess(4, 2)) === null && (await auth.resolveOrgAccess(4, 1)) === null);

    console.log("Test: listAccessibleOrgs — a firm member sees EXACTLY granted clients");
    let accessible = await auth.listAccessibleOrgs(1);
    check("firm accountant sees exactly [firm(1), clientA(2)]", JSON.stringify(sorted(accessible.map((o) => o.id))) === JSON.stringify([1, 2]));
    check("granted client is flagged viaFirm", accessible.find((o) => o.id === 2)?.viaFirm === true);
    check("own firm is not flagged viaFirm", accessible.find((o) => o.id === 1)?.viaFirm === false);
    check("firm viewer sees only their firm (no client access)", JSON.stringify((await auth.listAccessibleOrgs(2)).map((o) => o.id)) === JSON.stringify([1]));

    await grant(1, 3, "active", "tok-b"); // add client B
    accessible = await auth.listAccessibleOrgs(1);
    check("after granting clientB, firm sees [1,2,3]", JSON.stringify(sorted(accessible.map((o) => o.id))) === JSON.stringify([1, 2, 3]));

    console.log("Test: revocation kills access on the NEXT request");
    await pool.query(`UPDATE firm_client_access SET status='revoked', revoked_at=now() WHERE firm_org_id=1 AND client_org_id=2`);
    check("resolveOrgAccess(clientA) is null immediately after revoke", (await auth.resolveOrgAccess(1, 2)) === null);
    check("listAccessibleOrgs drops the revoked client → [1,3]", JSON.stringify(sorted((await auth.listAccessibleOrgs(1)).map((o) => o.id))) === JSON.stringify([1, 3]));

    console.log("Test: only an ACTIVE grant from an is_firm org confers access");
    await grant(1, 4, "pending", "tok-c"); // pending → no access
    check("pending grant confers no access", (await auth.resolveOrgAccess(1, 4)) === null);
    await grant(5, 2, "active", "tok-d"); // active grant but org 5 is is_firm=false
    check("active grant from a NON-firm org confers no access", (await auth.resolveOrgAccess(5, 2)) === null);

    console.log("Test: requireFirmContext — non-firm users cannot hit /api/firm/*");
    const run = (req: any) => {
      let code = 0; let called = false;
      const res: any = { status(c: number) { code = c; return this; }, json() { return this; } };
      firm.requireFirmContext(req as any, res, () => { called = true; });
      return { code, called };
    };
    check("unauthenticated → 401", run({}).code === 401);
    check("authenticated but active org is NOT a firm → 403", run({ user: { id: 3 }, org: { isFirm: false }, role: "owner" }).code === 403);
    check("firm member with viewer role → 403", run({ user: { id: 2 }, org: { isFirm: true }, role: "viewer" }).code === 403);
    const ok = run({ user: { id: 1 }, org: { isFirm: true }, role: "accountant" });
    check("firm accountant with firm active org → next()", ok.called === true && ok.code === 0);

    console.log("Test: clientTiles — per-client status");
    const empty = await firm.clientTiles(3);
    check("empty client tiles are all zero/open", empty.unreconciledBankLines === 0 && empty.overdueInvoices === 0 && empty.lastCloseDate === null && empty.currentPeriodOpen === true);
    // One unmatched bank line + a current-month close for client B (org 3).
    const bankAcct = (await pool.query(
      `INSERT INTO accounts (org_id, code, name, type, subtype, is_active) VALUES (3,'1000','Checking','asset','bank',true) RETURNING id`
    )).rows[0].id as number;
    await pool.query(`INSERT INTO bank_transactions (org_id, bank_account_id, date, description, amount, status) VALUES (3, $1, '2026-07-10', 'Uncategorized', -5000, 'unmatched')`, [bankAcct]);
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(`INSERT INTO period_locks (org_id, lock_date) VALUES (3, $1)`, [today]);
    const tiles = await firm.clientTiles(3);
    check("unreconciled bank line counted", tiles.unreconciledBankLines === 1);
    check("last close date reflects the lock", tiles.lastCloseDate === today);
    check("current period reads closed after a same-month close", tiles.currentPeriodOpen === false);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — firm access resolves, revokes on next request, and firm-only routes are guarded");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
