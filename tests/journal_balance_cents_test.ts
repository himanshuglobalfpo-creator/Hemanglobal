// tests/journal_balance_cents_test.ts
// Proves the postJournalEntrySchema balance refine compares in INTEGER CENTS,
// accepting float-dollar inputs that are balanced at the cent level and
// rejecting genuinely unbalanced or zero-total entries.
// Run: npx tsx tests/journal_balance_cents_test.ts  (no DB required)

import { postJournalEntrySchema } from "../shared/schema";

let failures = 0;

function makeEntry(debits: number[], credits: number[]) {
  // accountId values are arbitrary positive ints; the schema only validates shape/balance.
  const lines = [
    ...debits.map((d, i) => ({ accountId: i + 1, debit: d, credit: 0 })),
    ...credits.map((c, i) => ({ accountId: 100 + i, debit: 0, credit: c })),
  ];
  return { date: "2026-01-15", memo: "balance test", lines };
}

function expectAccepted(debits: number[], credits: number[], label: string) {
  const res = postJournalEntrySchema.safeParse(makeEntry(debits, credits));
  if (res.success) {
    console.log(`  ✅ ACCEPTED as expected: ${label}`);
  } else {
    failures++;
    const msg = res.error.issues.map((i) => i.message).join("; ");
    console.log(`  ❌ FALSELY REJECTED: ${label} — ${msg}`);
  }
}

function expectRejected(debits: number[], credits: number[], label: string) {
  const res = postJournalEntrySchema.safeParse(makeEntry(debits, credits));
  if (!res.success) {
    console.log(`  ✅ REJECTED as expected: ${label}`);
  } else {
    failures++;
    console.log(`  ❌ FALSELY ACCEPTED: ${label}`);
  }
}

console.log("Test: journal balance validator compares in integer cents");

// Must be ACCEPTED — balanced at the cent level, but unequal as IEEE-754 floats
expectAccepted([0.1, 0.2], [0.3], "[0.1, 0.2] vs [0.3] (classic float trap)");
expectAccepted([10.35, 5.28], [15.63], "[10.35, 5.28] vs [15.63]");
expectAccepted([33.33, 33.33, 33.34], [100], "[33.33, 33.33, 33.34] vs [100]");
expectAccepted([1099.99, 0.01], [1100.0], "[1099.99, 0.01] vs [1100.00]");

// Must be REJECTED — off by one cent, or zero total
expectRejected([10.0], [10.01], "[10.00] vs [10.01] (one-cent imbalance)");
expectRejected([0], [0], "[0] vs [0] (zero total)");

if (failures > 0) {
  console.log(`\n❌ ${failures} case(s) failed`);
  process.exit(1);
}
console.log("\n✅ ALL TESTS PASS — Zod balance check agrees with storage-layer integer cents");
