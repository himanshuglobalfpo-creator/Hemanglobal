// ============================================================================
// PLAID FEED BALANCE — mapping logic + summary surfacing
// ============================================================================
// The Banking cards show a bank-reported "feed balance" captured from Plaid.
// Live Plaid can't run here, so this splits into the two deterministic halves:
//
//   (1) pickFeedBalance() — the pure account-mapping rule: honor an explicit
//       Plaid account id, fall back to a sole account, and REFUSE to guess when
//       several accounts exist with no id (returns null).
//   (2) Against real Postgres: a stored feed balance on plaid_items surfaces in
//       bankAccountSummaries for the mapped GL account; the latest one wins; an
//       account with no Plaid link stays null.
//
// Run: tsx tests/plaid_feed_balance_test.ts
// ============================================================================

import { setupTestDb } from "./harness";
import { pickFeedBalance, type PlaidAccountBalance } from "../server/plaid";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const mkAcct = (id: string, current: number | null): PlaidAccountBalance => ({
  plaidAccountId: id, name: `Acct ${id}`, mask: "0000", type: "depository", subtype: "checking",
  currentCents: current, availableCents: current, currency: "USD",
});

async function main() {
  // ------------------------------------------------------------------------
  console.log("[1] pickFeedBalance — deterministic account mapping");
  // ------------------------------------------------------------------------
  const two = [mkAcct("a", 10000), mkAcct("b", 25000)];
  check("explicit id picks the matching account", pickFeedBalance(two, "b")?.plaidAccountId === "b");
  check("unknown explicit id → null (never guesses)", pickFeedBalance(two, "zzz") === null);
  check("no id + several accounts → null (ambiguous)", pickFeedBalance(two, null) === null);
  check("no id + single account → that account", pickFeedBalance([mkAcct("solo", 5000)], null)?.plaidAccountId === "solo");
  check("no id + single account, explicit undefined → that account", pickFeedBalance([mkAcct("solo", 5000)])?.plaidAccountId === "solo");

  // ------------------------------------------------------------------------
  console.log("\n[2] bankAccountSummaries surfaces the stored feed balance (real PG)");
  // ------------------------------------------------------------------------
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("plaid_feed_balance");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Feed Co', 'feed-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('f@f.test', 'x', 'Feed Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;

    // No Plaid link yet → feed balance null.
    let sums = await run(() => storage.bankAccountSummaries("bank"));
    check("feed balance null before any Plaid link", sums.find((x) => x.accountId === bank.id)!.feedBalanceCents === null);

    // Link an item and record a feed balance.
    const item = await run(() => storage.savePlaidItem({ bankAccountId: bank.id, accessToken: "access-tok", itemId: "item-1", plaidAccountId: "acc-1" }));
    await run(() => storage.updatePlaidItemFeedBalance(item.id, { feedBalanceCents: 123456, feedBalanceAt: "2026-06-10T12:00:00.000Z" }));
    sums = await run(() => storage.bankAccountSummaries("bank"));
    let s = sums.find((x) => x.accountId === bank.id)!;
    check("feed balance surfaced after capture", s.feedBalanceCents === 123456, String(s.feedBalanceCents));
    check("feed balance date surfaced", s.feedBalanceAt === "2026-06-10T12:00:00.000Z", String(s.feedBalanceAt));

    // A newer capture (later item) wins.
    const item2 = await run(() => storage.savePlaidItem({ bankAccountId: bank.id, accessToken: "access-tok-2", itemId: "item-2", plaidAccountId: "acc-2" }));
    await run(() => storage.updatePlaidItemFeedBalance(item2.id, { feedBalanceCents: 200000, feedBalanceAt: "2026-06-11T09:00:00.000Z" }));
    sums = await run(() => storage.bankAccountSummaries("bank"));
    s = sums.find((x) => x.accountId === bank.id)!;
    check("latest feed balance wins", s.feedBalanceCents === 200000, String(s.feedBalanceCents));

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} plaid-feed-balance check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll Plaid feed-balance mapping + summary tests passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
