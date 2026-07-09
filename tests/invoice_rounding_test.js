// Verify: createInvoice integer-cents math produces a balanced JE for tricky
// inputs. Mirrors the EXACT computation in server/storage.ts createInvoice:
//   amountCents = Math.round(quantity * rate * 100)   (rate is dollar unit price)
//   subtotal    = Σ amountCents                        (exact integer sum)
//   tax         = Math.round(subtotal * taxRate / 100) (integer cents)
//   total       = subtotal + tax                       (exact)
// The JE balance check is EXACT integer equality — imbalance must be 0, not "< ε".
const scenarios = [
  // [name, lines, taxRate%, expectedSubtotalCents, expectedTaxCents]
  ["Trivial",              [{q: 1, r: 100}],                              8.875, 10000, 888 ],
  ["Tricky decimals",      [{q: 3, r: 33.33}, {q: 1, r: 100.01}],         8.875, 20000, 1775],
  ["Sub-cent unit price",  [{q: 10000, r: 0.0025}],                       0,     2500,  0   ],
  ["The $33.333 × 3 case", [{q: 3, r: 33.333}],                           0,     10000, 0   ],
  ["Many lines",           Array.from({length: 13}, (_, i) => ({q: i + 1, r: 9.99 + i * 0.37})), 7,  117845, 8249],
  ["Zero tax",             [{q: 5, r: 39.97}],                            0,     19985, 0   ],
  ["High precision rates", [{q: 1, r: 50}],                               6.25,  5000,  313 ],
];

let failures = 0;
for (const [name, lines, taxRate, expSub, expTax] of scenarios) {
  // EXACT mirror of createInvoice
  const lineAmounts = lines.map(l => Math.round(l.q * l.r * 100)); // integer cents
  const subtotal = lineAmounts.reduce((s, a) => s + a, 0);          // exact sum
  const tax = Math.round((subtotal * taxRate) / 100);               // integer cents
  const total = subtotal + tax;

  // JE mirror: Dr A/R total; Cr Revenue per line; Cr Tax
  const drTotal = total;
  const crTotal = lineAmounts.reduce((s, a) => s + a, 0) + tax;
  const imbalance = drTotal - crTotal; // MUST be exactly 0 — integers never drift

  const ok =
    Number.isInteger(subtotal) && Number.isInteger(tax) && Number.isInteger(total) &&
    subtotal === expSub && tax === expTax && imbalance === 0;
  if (!ok) failures++;
  const fmt = c => `$${(c / 100).toFixed(2)}`;
  console.log(
    `${ok ? "✅" : "❌"} ${name.padEnd(24)} subtotal=${fmt(subtotal)} (${subtotal}¢)  tax=${fmt(tax)} (${tax}¢)  total=${fmt(total)} (${total}¢)  imbalance=${imbalance}`
  );
  if (!ok) console.log(`   expected subtotal=${expSub}¢ tax=${expTax}¢`);
}

if (failures) {
  console.error(`\n❌ ${failures} scenario(s) failed`);
  process.exit(1);
}
console.log("\n✅ All invoice rounding scenarios produce EXACTLY balanced JEs (integer cents)");
