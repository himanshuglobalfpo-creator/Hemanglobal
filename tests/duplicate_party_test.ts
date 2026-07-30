// ============================================================================
// DUPLICATE CUSTOMER / VENDOR NAME DETECTION (BUG-006)
// ============================================================================
// Proves, against a real Postgres:
//
//   (1) Creating a customer whose name matches an existing one (case-
//       insensitive, same org) is rejected with a 409 that carries the
//       existing record's id.
//   (2) `force` bypasses the check and creates the duplicate on purpose.
//   (3) The same rules apply to vendors.
//   (4) Detection is per-org: an identical name in another org is allowed.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/duplicate_party_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("duplicate_party");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Dup Co', 'dup-co')`);
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Other Co', 'other-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('d@d.test', 'x', 'Dup Tester')`);
    await seedOrgDefaults(1);
    await seedOrgDefaults(2);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);
    const runOrg2 = <T>(fn: () => Promise<T>) => withOrg({ orgId: 2, userId: 1 }, fn);

    // ------------------------------------------------------------------------
    console.log("\n[1] First customer creates fine; a case-insensitive match is a 409");
    // ------------------------------------------------------------------------
    const acme = await run(() => storage.createCustomer({ name: "Acme Corp" } as any));
    check("first 'Acme Corp' created", !!acme.id);

    let dupErr: any = null;
    try {
      await run(() => storage.createCustomer({ name: "  acme corp  ".trim() } as any)); // same name, different case
    } catch (e: any) { dupErr = e; }
    check("duplicate 'acme corp' is rejected", !!dupErr, "no error thrown");
    check("rejection is a 409", dupErr?.httpStatus === 409, String(dupErr?.httpStatus));
    check("409 carries the existing customer id", dupErr?.existing?.id === acme.id, JSON.stringify(dupErr?.existing));

    // Exactly one 'Acme Corp' persisted.
    const acmeCount = (await pool.query(`SELECT COUNT(*)::int AS c FROM customers WHERE org_id = 1 AND lower(name) = 'acme corp'`)).rows[0].c as number;
    check("still exactly one Acme Corp in the DB", acmeCount === 1, String(acmeCount));

    // ------------------------------------------------------------------------
    console.log("\n[2] force bypasses the check and creates the duplicate");
    // ------------------------------------------------------------------------
    const acme2 = await run(() => storage.createCustomer({ name: "Acme Corp" } as any, { force: true }));
    check("force creates a second Acme Corp", !!acme2.id && acme2.id !== acme.id);
    const acmeCount2 = (await pool.query(`SELECT COUNT(*)::int AS c FROM customers WHERE org_id = 1 AND lower(name) = 'acme corp'`)).rows[0].c as number;
    check("now two Acme Corp rows exist", acmeCount2 === 2, String(acmeCount2));

    // ------------------------------------------------------------------------
    console.log("\n[3] Vendors follow the same rules");
    // ------------------------------------------------------------------------
    const aws = await run(() => storage.createVendor({ name: "AWS" } as any));
    check("first 'AWS' vendor created", !!aws.id);
    let vdupErr: any = null;
    try {
      await run(() => storage.createVendor({ name: "aws" } as any));
    } catch (e: any) { vdupErr = e; }
    check("duplicate 'aws' vendor is a 409 with existing id", vdupErr?.httpStatus === 409 && vdupErr?.existing?.id === aws.id, JSON.stringify(vdupErr?.existing));
    const forcedVendor = await run(() => storage.createVendor({ name: "AWS" } as any, { force: true }));
    check("force creates the duplicate vendor", !!forcedVendor.id && forcedVendor.id !== aws.id);

    // ------------------------------------------------------------------------
    console.log("\n[4] Detection is per-org: the same name in another org is allowed");
    // ------------------------------------------------------------------------
    const acmeOrg2 = await runOrg2(() => storage.createCustomer({ name: "Acme Corp" } as any));
    check("another org can create 'Acme Corp' without a conflict", !!acmeOrg2.id);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} duplicate-party check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll duplicate customer/vendor detection tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
