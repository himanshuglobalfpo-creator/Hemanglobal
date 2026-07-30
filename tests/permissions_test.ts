// ============================================================================
// PERMISSIONS & CUSTOM ROLES (P3.11)
// ============================================================================
// Pins the permission matrix and its guards:
//   1. roleGrants — built-in role → permission resolution (owner=all, viewer=
//      read-only, accountant=bookkeeping, custom=explicit set).
//   2. requirePermission — allows/denies per role, incl. a DB-backed custom role.
//   3. Custom roles: owner (and other built-ins) are immutable; a stored role
//      resolves its permissions.
//   4. Static integrity: every requirePermission("X") in the routes uses a valid
//      permission key, and the built-in role sets reference only valid keys.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupTestDb } from "./harness";
import { PERMISSION_KEYS, BUILTIN_ROLE_PERMISSIONS, roleGrants, isBuiltinRole } from "../shared/permissions";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

// Minimal fake express req/res to drive the middleware.
function runMw(mw: any, req: any): Promise<{ code: number; called: boolean }> {
  return new Promise((resolve) => {
    let code = 0; let called = false;
    const res: any = { status(c: number) { code = c; return this; }, json() { resolve({ code, called }); return this; } };
    Promise.resolve(mw(req, res, () => { called = true; resolve({ code, called }); }));
  });
}

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("permissions");
  try {
    const auth = await import("../server/auth");

    console.log("Test: built-in role → permission resolution");
    check("owner grants everything", PERMISSION_KEYS.every((k) => roleGrants("owner", k)));
    check("viewer grants reports.read", roleGrants("viewer", "reports.read"));
    check("viewer does NOT grant invoices.write", !roleGrants("viewer", "invoices.write"));
    check("accountant grants invoices.write", roleGrants("accountant", "invoices.write"));
    check("accountant does NOT grant members.admin", !roleGrants("accountant", "members.admin"));
    check("admin grants settings.admin", roleGrants("admin", "settings.admin"));
    check("isBuiltinRole recognizes the four roles", ["owner", "admin", "accountant", "viewer"].every(isBuiltinRole) && !isBuiltinRole("Auditor"));

    console.log("Test: requirePermission middleware (built-in roles)");
    const mw = auth.requirePermission("invoices.write");
    check("unauthenticated → 401", (await runMw(mw, {})).code === 401);
    check("owner → next()", (await runMw(mw, { user: { id: 1 }, org: { id: 1 }, role: "owner" })).called === true);
    check("viewer → 403", (await runMw(mw, { user: { id: 1 }, org: { id: 1 }, role: "viewer" })).code === 403);
    check("accountant → next()", (await runMw(mw, { user: { id: 1 }, org: { id: 1 }, role: "accountant" })).called === true);
    const readMw = auth.requirePermission("reports.read");
    check("viewer passes a read permission", (await runMw(readMw, { user: { id: 1 }, org: { id: 1 }, role: "viewer" })).called === true);

    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Permco','permco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('p@p.test','x','Perm')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      console.log("Test: custom roles (owner immutable, permissions stored & resolved)");
      let blocked = false;
      try { await storage.createOrgRole("Owner", ["reports.read"]); } catch { blocked = true; }
      check("cannot redefine a built-in role name (owner)", blocked);

      const role = await storage.createOrgRole("Auditor", ["reports.read", "invoices.read", "not.a.real.key"]);
      check("custom role created", role.name === "Auditor");
      check("invalid permission keys are dropped", role.permissions.includes("reports.read") && !role.permissions.includes("not.a.real.key"));

      const perms = await auth.getCustomRolePermissions(1, "Auditor");
      check("custom role permissions resolve from the DB", perms.includes("reports.read") && perms.includes("invoices.read"));

      // A member holding the custom role: read allowed, write denied.
      check("custom Auditor grants reports.read", roleGrants("Auditor", "reports.read", perms as any));
      check("custom Auditor does NOT grant invoices.write", !roleGrants("Auditor", "invoices.write", perms as any));
      const wmw = auth.requirePermission("invoices.write");
      check("requirePermission denies the custom Auditor a write", (await runMw(wmw, { user: { id: 1 }, org: { id: 1 }, role: "Auditor" })).code === 403);
      const rmw = auth.requirePermission("reports.read");
      check("requirePermission allows the custom Auditor a read", (await runMw(rmw, { user: { id: 1 }, org: { id: 1 }, role: "Auditor" })).called === true);

      check("deleting the role works", (await storage.deleteOrgRole(role.id)) === true);
    });

    console.log("Test: route integrity — every requirePermission key is valid");
    const routesSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "routes.ts"), "utf8");
    const used = [...routesSrc.matchAll(/requirePermission\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    check("routes actually adopt requirePermission", used.length > 0);
    const invalid = used.filter((k) => !(PERMISSION_KEYS as readonly string[]).includes(k));
    check("every requirePermission(key) in routes is a valid permission", invalid.length === 0);
    const badBuiltin = Object.values(BUILTIN_ROLE_PERMISSIONS).flat().filter((k) => !(PERMISSION_KEYS as readonly string[]).includes(k));
    check("built-in role sets reference only valid permissions", badBuiltin.length === 0);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — permission matrix, requirePermission guards, custom roles, owner immutable");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
