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
  insertItemSchema,
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

  // Inventory items: a request must not be able to choose its tenant OR forge
  // stock levels — quantityOnHand / avgCostCents are derived from movements.
  const item = insertItemSchema.parse({
    sku: "SKU-1", name: "Widget", type: "inventory",
    salesAccountId: 1, expenseAccountId: 2, inventoryAssetAccountId: 3, cogsAccountId: 4,
    orgId: 999, quantityOnHand: 100000, avgCostCents: 1,
  } as any);
  check("item: orgId stripped from parsed output", !("orgId" in item));
  check("item: quantityOnHand stripped (cannot forge stock)", !("quantityOnHand" in item));
  check("item: avgCostCents stripped (cannot forge cost)", !("avgCostCents" in item));

  const badItem = insertItemSchema.safeParse({
    sku: "SKU-2", name: "No Asset", type: "inventory",
    salesAccountId: 1, expenseAccountId: 2, cogsAccountId: 4,
  } as any);
  check("item: inventory type without inventoryAssetAccountId rejected", !badItem.success);
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
