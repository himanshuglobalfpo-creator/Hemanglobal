/**
 * TaxJar integration logic test — runs against the REAL server/taxjar.ts.
 * No network, no database: with TAXJAR_API_KEY unset, calculateSalesTax()
 * exercises the nexus gate and the manual-fallback path, which is exactly
 * the behavior invoice creation relies on when TaxJar is down or unconfigured.
 *
 * Run with: npx tsx tests/taxjar_logic_test.ts
 */
delete process.env.TAXJAR_API_KEY; // force the no-key path deterministically
process.env.TAXJAR_SANDBOX = "true";

import {
  calculateSalesTax,
  validateAddress,
  hasNexusIn,
  manualTaxCents,
  toCents,
  taxjarStatus,
} from "../server/taxjar";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → got ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

async function main() {
  console.log("Test: status reflects configuration");
  {
    const st = taxjarStatus();
    check("unconfigured when no API key", st.configured === false, st);
    check("sandbox flag read from env", st.sandbox === true, st);
  }

  console.log("Test: cents helpers");
  {
    check("toCents(8.25) = 825", toCents(8.25) === 825, toCents(8.25));
    check("toCents(0.1 + 0.2 dollars) = 30 (no float drift)", toCents(0.1 + 0.2) === 30, toCents(0.1 + 0.2));
    check("manualTaxCents(10000, 8.25) = 825", manualTaxCents(10000, 8.25) === 825, manualTaxCents(10000, 8.25));
    check("manualTaxCents rounds half-up (10001 @ 8.25% = 825)", manualTaxCents(10001, 8.25) === 825, manualTaxCents(10001, 8.25));
  }

  console.log("Test: nexus gate");
  {
    check("TX in [TX, CA]", hasNexusIn("TX", ["TX", "CA"]));
    check("case-insensitive (tx in [TX])", hasNexusIn("tx", ["TX"]));
    check("NY not in [TX, CA]", !hasNexusIn("NY", ["TX", "CA"]));
  }

  console.log("Test: no nexus in destination state → tax = 0, no fallback applied");
  {
    const r = await calculateSalesTax({
      fromZip: "94103", fromState: "CA",
      toZip: "78701", toState: "TX", toCity: "Austin",
      amount: 10000,
      nexusStates: ["CA"], // org has nexus in CA only — TX sale owes nothing
      fallback: { rate: 8.25, label: "TX Sales Tax" },
    });
    check("taxAmount = 0", r.taxAmount === 0, r);
    check("source = no_nexus", r.source === "no_nexus", r.source);
  }

  console.log("Test: nexus present + TaxJar unconfigured → manual fallback, correct cents");
  {
    const r = await calculateSalesTax({
      fromZip: "78701", fromState: "TX",
      toZip: "78701", toState: "TX", toCity: "Austin",
      amount: 10000, // $100.00
      nexusStates: ["TX"],
      fallback: { rate: 8.25, label: "TX Sales Tax" },
    });
    check("taxAmount = 825 cents ($8.25)", r.taxAmount === 825, r);
    check("taxRate = 8.25", r.taxRate === 8.25, r.taxRate);
    check("source = manual_fallback", r.source === "manual_fallback", r.source);
    check("warning present for audit trail", typeof r.warning === "string" && r.warning.length > 0, r.warning);
    check(
      "breakdown sums to taxAmount",
      r.breakdown.stateTax + r.breakdown.countyTax + r.breakdown.cityTax + r.breakdown.specialDistrictTax === r.taxAmount,
      r.breakdown
    );
  }

  console.log("Test: nexus present, no fallback rate available → 0 tax with warning (never throws)");
  {
    const r = await calculateSalesTax({
      fromZip: "78701", fromState: "TX",
      toZip: "78701", toState: "TX",
      amount: 10000,
      nexusStates: ["TX"],
      // no fallback — org has no tax codes configured
    });
    check("taxAmount = 0", r.taxAmount === 0, r);
    check("warning explains why", typeof r.warning === "string", r.warning);
  }

  console.log("Test: input validation still throws (caller bugs, not API failures)");
  {
    let threw = false;
    try {
      await calculateSalesTax({
        fromZip: "78701", fromState: "TX", toZip: "78701", toState: "Texas", // invalid
        amount: 10000, nexusStates: ["TX"],
      });
    } catch { threw = true; }
    check("non-2-char state rejected", threw);

    threw = false;
    try {
      await calculateSalesTax({
        fromZip: "78701", fromState: "TX", toZip: "78701", toState: "TX",
        amount: 100.5 as any, // not integer cents
        nexusStates: ["TX"],
      });
    } catch { threw = true; }
    check("non-integer cents rejected", threw);
  }

  console.log("Test: validateAddress degrades gracefully without API key");
  {
    const r = await validateAddress({ city: "Austin", state: "TX", zip: "78701" });
    check("valid = false, no throw", r.valid === false, r);
    check("warning explains unconfigured", typeof r.warning === "string", r.warning);
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ ALL TESTS PASS — nexus gating, fallback, and cents math verified");
}

main();
