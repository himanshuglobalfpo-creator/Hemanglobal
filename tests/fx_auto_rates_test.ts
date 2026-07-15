// ============================================================================
// AUTOMATIC FX RATES (P3.7) — manual-override precedence & provider failure
// ============================================================================
// Graded invariants:
//   1. Manual overrides win: an auto refresh NEVER overwrites a rate a human
//      entered for the same date; it fills in the rest.
//   2. Provider failure is safe: a throwing provider leaves prior rates intact
//      and returns { ok:false, error } (a warning, not a crash).
//
// Providers are injected (no network). Postgres harness (uses $DATABASE_URL if
// set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

// Injected fake providers.
const okProvider = { name: "fake-ok", async fetchRates(_base: string, symbols: string[]) {
  const table: Record<string, number> = { EUR: 1.10, GBP: 1.27, JPY: 0.0067 };
  const out: Record<string, number> = {};
  for (const s of symbols) if (table[s] != null) out[s] = table[s];
  return out;
} };
const failProvider = { name: "fake-fail", async fetchRates() { throw new Error("provider unavailable (503)"); } };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("fx_auto_rates");
  try {
    await pool.query(`INSERT INTO organizations (name, slug, base_currency) VALUES ('Fxco','fxco','USD')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('f@f.test','x','Fx')`);
    await seedOrgDefaults(1);
    const rateOf = async (from: string) => (await pool.query(`SELECT rate, source FROM fx_rates WHERE org_id=1 AND date='2026-06-01' AND from_code=$1 AND to_code='USD'`, [from])).rows[0];

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      // A human sets EUR→USD manually for the day.
      await storage.upsertFxRate({ date: "2026-06-01", fromCode: "EUR", toCode: "USD", rate: 1.5, source: "manual" });

      console.log("Test: auto refresh fills gaps but never overwrites a manual rate");
      const res = await storage.refreshFxRatesForOrg(okProvider, { asOf: "2026-06-01", currencies: ["EUR", "GBP"] });
      check("refresh ok", res.ok === true && res.provider === "fake-ok");
      check("one rate written (GBP), one kept manual (EUR)", res.updated === 1 && res.skipped === 1);
      const eur = await rateOf("EUR"); const gbp = await rateOf("GBP");
      check("manual EUR rate untouched (1.5, source manual)", Number(eur.rate) === 1.5 && eur.source === "manual");
      check("GBP auto-filled (1.27, source system)", Number(gbp.rate) === 1.27 && gbp.source === "system");

      console.log("Test: a later manual edit wins over the system rate");
      await storage.upsertFxRate({ date: "2026-06-01", fromCode: "GBP", toCode: "USD", rate: 1.30, source: "manual" });
      const res2 = await storage.refreshFxRatesForOrg(okProvider, { asOf: "2026-06-01", currencies: ["EUR", "GBP"] });
      check("both now manual → both skipped", res2.updated === 0 && res2.skipped === 2);
      check("GBP stays at the manual 1.30", Number((await rateOf("GBP")).rate) === 1.30);

      console.log("Test: provider failure leaves prior rates intact and warns");
      const before = { eur: await rateOf("EUR"), gbp: await rateOf("GBP") };
      const failed = await storage.refreshFxRatesForOrg(failProvider, { asOf: "2026-06-01", currencies: ["EUR", "GBP"] });
      check("failure reported (ok:false + error message)", failed.ok === false && /unavailable/.test(failed.error || ""));
      check("no rates written on failure", failed.updated === 0 && failed.skipped === 0);
      const after = { eur: await rateOf("EUR"), gbp: await rateOf("GBP") };
      check("EUR unchanged after failure", Number(after.eur.rate) === Number(before.eur.rate) && after.eur.source === before.eur.source);
      check("GBP unchanged after failure", Number(after.gbp.rate) === Number(before.gbp.rate) && after.gbp.source === before.gbp.source);

      console.log("Test: no document currencies → safe no-op");
      const empty = await storage.refreshFxRatesForOrg(okProvider, { asOf: "2026-06-02" }); // uses real doc currencies (none)
      check("no-op when the org has no foreign-currency documents", empty.ok === true && empty.updated === 0 && empty.currencies.length === 0);

      // Status surfaces the last auto fetch: write a fresh system rate on a new
      // date (JPY has no manual rate), then confirm the status reflects it.
      const fresh = await storage.refreshFxRatesForOrg(okProvider, { asOf: "2026-06-03", currencies: ["JPY"] });
      check("fresh currency auto-filled", fresh.updated === 1);
      const status = await storage.fxAutoStatus();
      check("status reports the latest system fetch", status.systemRateCount >= 1 && status.lastFetchDate === "2026-06-03");
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — manual overrides win; provider failure keeps prior rates intact");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
