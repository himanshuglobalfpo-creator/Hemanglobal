/**
 * Tenancy input-hardening test — runs against the REAL shared/schema.ts
 * (unlike multi_tenant_test.js, which tests a mirror of the storage logic).
 *
 * Verifies:
 *   1. Client-facing insert schemas STRIP orgId — a request body cannot choose
 *      its tenant (mass-assignment protection). Storage stamps currentOrgId().
 *   2. bankRuleUpdateSchema / updateRecurringSchema exist, accept partial
 *      payloads, and still enforce cross-field rules when the fields are present.
 *
 * Run with: npx tsx tests/schema_tenancy_test.ts
 */
import {
  insertAccountSchema,
  insertCustomerSchema,
  insertVendorSchema,
  bankRuleSchema,
  bankRuleUpdateSchema,
  createRecurringSchema,
  updateRecurringSchema,
} from "../shared/schema";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}

console.log("Test: insert schemas strip client-supplied orgId");
{
  const cust = insertCustomerSchema.parse({ name: "Evil Corp", orgId: 999 } as any);
  check("customer: orgId stripped from parsed output", !("orgId" in cust));

  const vend = insertVendorSchema.parse({ name: "Shady Vendor", orgId: 999 } as any);
  check("vendor: orgId stripped from parsed output", !("orgId" in vend));

  const acct = insertAccountSchema.parse({
    code: "9999", name: "Sneaky", type: "expense", subtype: "other_expense", isActive: true, orgId: 999,
  } as any);
  check("account: orgId stripped from parsed output", !("orgId" in acct));
}

console.log("Test: bank rule PATCH schema");
{
  const ok = bankRuleUpdateSchema.safeParse({ priority: 5 });
  check("partial update (priority only) parses", ok.success);

  const bad = bankRuleUpdateSchema.safeParse({ amountComparator: "between", amountMin: 10, amountMax: 5 });
  check("between with min >= max rejected", !bad.success);

  const full = bankRuleSchema.safeParse({ name: "r", actionType: "categorize" });
  check("create without categoryAccountId rejected", !full.success);
}

console.log("Test: recurring PATCH schema");
{
  const ok = updateRecurringSchema.safeParse({ isActive: false });
  check("partial update (isActive only) parses", ok.success);

  const bad = updateRecurringSchema.safeParse({ startDate: "2026-05-01", endDate: "2026-04-01" });
  check("endDate before startDate rejected", !bad.success);

  const create = createRecurringSchema.safeParse({
    name: "Rent", kind: "bill", frequency: "monthly", startDate: "2026-01-01",
    payload: { vendorId: 1, lines: [] },
  });
  check("valid create still parses", create.success);
}

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\n✅ ALL TESTS PASS — tenant field cannot be set from request bodies");
