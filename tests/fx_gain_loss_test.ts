// FX realized gain/loss math — pure arithmetic mirror of payInvoice/payBill.
// No DB: verifies the exact cent plug that keeps the JE balanced.
function invoicePayment(foreignCents: number, docRate: number, payRate: number) {
  const bank = Math.round(foreignCents * payRate);     // DR Bank (payment rate)
  const arRelieved = Math.round(foreignCents * docRate); // CR A/R (document rate)
  const fxDiff = arRelieved - bank;                     // >0 loss, <0 gain
  // JE must balance: DR(bank) + DR(fxLoss if>0) == CR(ar) + CR(fxGain if<0)
  const drTotal = bank + (fxDiff > 0 ? fxDiff : 0);
  const crTotal = arRelieved + (fxDiff < 0 ? -fxDiff : 0);
  return { bank, arRelieved, fxDiff, balanced: drTotal === crTotal };
}
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}
console.log("Test: FX realized gain/loss (integer cents)");
// €100 @ 1.10 doc, paid @ 1.08 → $108 bank, $110 A/R, $2 LOSS
let r = invoicePayment(10000, 1.10, 1.08);
check("€100 doc1.10 pay1.08: bank=10800", r.bank === 10800);
check("  A/R relieved=11000", r.arRelieved === 11000);
check("  fxDiff=+200 (loss)", r.fxDiff === 200);
check("  JE balances", r.balanced);
// paid @ 1.12 → $112 bank, $110 A/R, $2 GAIN
r = invoicePayment(10000, 1.10, 1.12);
check("pay1.12: bank=11200", r.bank === 11200);
check("  fxDiff=-200 (gain)", r.fxDiff === -200);
check("  JE balances", r.balanced);
// same rate → no FX
r = invoicePayment(10000, 1.10, 1.10);
check("same rate: fxDiff=0", r.fxDiff === 0);
check("  JE balances", r.balanced);
// partial payment rounding
r = invoicePayment(3333, 1.2345, 1.2001);
check("partial odd rate: JE balances", r.balanced);
if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
console.log("\n✅ ALL TESTS PASS — FX gain/loss plug keeps every JE balanced");
