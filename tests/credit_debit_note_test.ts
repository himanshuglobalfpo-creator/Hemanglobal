// ============================================================================
// CREDIT NOTE / DEBIT NOTE — end-to-end acceptance test
// ============================================================================
// Proves the module's "done when" criteria:
//   1. createCreditNote() posts the correct GL entry (Dr Revenue / Cr A/R)
//   2. applyCreditNote() reduces the invoice outstanding balance
//      ($1,000 invoice + $200 credit applied → outstanding $800)
//   3. AR aging shows unapplied credit notes as NEGATIVE balances
//   4. Trial balance still balances (credit notes flow through the GL)
//   5. Business rules: no over-apply, no cross-customer apply,
//      no void-after-apply, debit note mirror works
//
// Run: tsx tests/credit_debit_note_test.ts
// Uses a throwaway working directory so the dev data.db is untouched.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate: storage.ts opens "data.db" relative to CWD.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-cn-test-"));
process.chdir(tmp);

async function main() {
const { storage, db, sqlite } = await import("../server/storage");
const noteSvc = await import("../server/creditNoteService");
const { withOrg } = await import("../server/org-scope");
const { journalLines, journalEntries, accounts, creditNoteApplications } = await import("../shared/schema");
const { eq } = await import("drizzle-orm");

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function expectThrow(label: string, fn: () => unknown, pattern: RegExp) {
  try {
    fn();
    failures++;
    console.error(`  ✗ ${label} — expected an error, none thrown`);
  } catch (e: any) {
    check(label, pattern.test(String(e?.message)), `got: ${e?.message}`);
  }
}
const money = (n: number) => `$${(n / 100).toFixed(2)}`; // cents → display

withOrg({ orgId: 1, userId: 1 }, () => {
  // ---- Setup: chart of accounts is seeded by initSchema; grab what we need.
  const acct = (code: string) =>
    db.select().from(accounts).where(eq(accounts.code, code)).all().find((a) => a.orgId === 1)!;
  const ar = acct("1100");
  const ap = acct("2000");
  const revenue = db.select().from(accounts).all().find((a) => a.orgId === 1 && a.type === "income")!;
  const expense = db.select().from(accounts).all().find((a) => a.orgId === 1 && a.type === "expense")!;

  const custA = storage.createCustomer({ name: "Acme Corp" });
  const custB = storage.createCustomer({ name: "Beta LLC" });
  const vendor = storage.createVendor({ name: "Office Supplies Inc" });

  // ==========================================================================
  console.log("\n[1] $200 credit note posts the correct GL entry");
  // ==========================================================================
  const cn = noteSvc.createCreditNote({
    customerId: custA.id,
    date: "2026-07-01",
    reason: "Goods returned",
    taxRate: 0,
    lines: [{ description: "Returned widgets", quantity: 2, rate: 100, revenueAccountId: revenue.id }],
  });
  check("credit note number is CN-0001", cn.number === "CN-0001", cn.number);
  check("status is 'issued'", cn.status === "issued", cn.status);
  check("total is $200.00", cn.total === 20000, money(cn.total)); // 20000 cents
  check("remainingCredit is $200.00", cn.remainingCredit === 20000, money(cn.remainingCredit));

  const je = db.select().from(journalEntries).where(eq(journalEntries.id, cn.journalEntryId)).get()!;
  const jeLines = db.select().from(journalLines).where(eq(journalLines.entryId, je.id)).all();
  console.log(`\n  Journal entry #${je.id} — "${je.memo}"`);
  console.log("  ┌──────────────────────────────────┬──────────┬──────────┐");
  console.log("  │ Account                          │    Debit │   Credit │");
  console.log("  ├──────────────────────────────────┼──────────┼──────────┤");
  for (const l of jeLines) {
    const a = db.select().from(accounts).where(eq(accounts.id, l.accountId)).get()!;
    console.log(
      `  │ ${(a.code + " " + a.name).padEnd(32)} │ ${l.debit ? money(l.debit).padStart(8) : "        "} │ ${l.credit ? money(l.credit).padStart(8) : "        "} │`
    );
  }
  console.log("  └──────────────────────────────────┴──────────┴──────────┘");
  const revLine = jeLines.find((l) => l.accountId === revenue.id);
  const arLine = jeLines.find((l) => l.accountId === ar.id);
  check("Dr Revenue $200 (reduces revenue)", revLine?.debit === 20000 && revLine?.credit === 0);
  check("Cr Accounts Receivable $200", arLine?.credit === 20000 && arLine?.debit === 0);
  check("no Cash account touched", jeLines.every((l) => {
    const a = db.select().from(accounts).where(eq(accounts.id, l.accountId)).get()!;
    return a.subtype !== "bank";
  }));
  const drTotal = jeLines.reduce((s, l) => s + l.debit, 0);
  const crTotal = jeLines.reduce((s, l) => s + l.credit, 0);
  check("entry balances (Dr = Cr)", drTotal === crTotal); // EXACT integer equality

  // ==========================================================================
  console.log("\n[2] Apply $200 credit to a $1,000 invoice → outstanding $800");
  // ==========================================================================
  const inv = storage.createInvoice({
    number: "INV-1001",
    customerId: custA.id,
    date: "2026-06-15",
    dueDate: "2026-07-15",
    taxRate: 0,
    lines: [{ description: "Consulting", quantity: 10, rate: 100, incomeAccountId: revenue.id }],
  });
  const before = inv.total - inv.amountPaid; // exact integer cents
  console.log(`  BEFORE: invoice ${inv.number} total ${money(inv.total)}, paid ${money(inv.amountPaid)}, outstanding ${money(before)}`);
  check("invoice outstanding before = $1,000.00", before === 100000);

  const applied = noteSvc.applyCreditNote(cn.id, inv.id, 200);
  const after = applied.invoice.total - applied.invoice.amountPaid; // exact
  console.log(`  AFTER:  invoice ${applied.invoice.number} total ${money(applied.invoice.total)}, paid ${money(applied.invoice.amountPaid)}, outstanding ${money(after)}`);
  check("invoice outstanding after = $800.00", after === 80000, money(after));
  check("credit note appliedAmount = $200.00", applied.creditNote.appliedAmount === 20000);
  check("credit note remainingCredit = $0.00", applied.creditNote.remainingCredit === 0);
  check("credit note status flips to 'applied'", applied.creditNote.status === "applied");
  const jeCountForApply = db.select().from(journalEntries).all().filter((e) => e.source === "credit_note_application").length;
  check("application posted NO new journal entry", jeCountForApply === 0);

  // ==========================================================================
  console.log("\n[3] AR aging shows unapplied credit notes as negative balances");
  // ==========================================================================
  const cn2 = noteSvc.createCreditNote({
    customerId: custB.id,
    date: "2026-07-02",
    reason: "Pricing error",
    taxRate: 0,
    lines: [{ description: "Overbilled hours", quantity: 1, rate: 150, revenueAccountId: revenue.id }],
  });
  check("second credit note is CN-0002", cn2.number === "CN-0002", cn2.number);
  const aging = storage.arAging("2026-07-05");
  const betaRow = aging.rows.find((r: any) => r.customerId === custB.id);
  console.log(`  Beta LLC aging row: current=${money(betaRow?.current ?? 0)}, total=${money(betaRow?.total ?? 0)}`);
  check("Beta LLC shows NEGATIVE -$150.00 (unapplied credit)", betaRow?.total === -15000, money(betaRow?.total ?? 0));
  const cnDetail = betaRow?.invoices.find((i: any) => i.number === "CN-0002");
  check("CN-0002 appears in the row detail with negative balance", cnDetail?.balance === -15000);
  check("aging total reconciles with A/R GL balance", !aging.warning, aging.warning);

  // ==========================================================================
  console.log("\n[4] Trial balance still balances (GL flow verified)");
  // ==========================================================================
  const tb = (storage as any).trialBalance
    ? (storage as any).trialBalance("2026-07-05")
    : null;
  if (tb) {
    const dr = tb.totals?.debit ?? tb.totalDebit;
    const cr = tb.totals?.credit ?? tb.totalCredit;
    check("trial balance Dr = Cr", Math.abs(dr - cr) < 0.01, `Dr ${dr} vs Cr ${cr}`);
  } else {
    // Fall back to summing every journal line.
    const all = db.select().from(journalLines).all();
    const dr = +all.reduce((s, l) => s + l.debit, 0).toFixed(2);
    const crx = +all.reduce((s, l) => s + l.credit, 0).toFixed(2);
    check("all journal lines balance (Dr = Cr)", Math.abs(dr - crx) < 0.01, `Dr ${dr} vs Cr ${crx}`);
  }

  // ==========================================================================
  console.log("\n[5] Business rules enforced");
  // ==========================================================================
  expectThrow(
    "cannot apply more than remaining credit",
    () => noteSvc.applyCreditNote(cn.id, inv.id, 50), // cn is fully applied
    /\$0\.00 remaining|remaining/i
  );
  const invB = storage.createInvoice({
    number: "INV-2001",
    customerId: custB.id,
    date: "2026-07-01",
    dueDate: "2026-08-01",
    taxRate: 0,
    lines: [{ description: "Design", quantity: 1, rate: 500, incomeAccountId: revenue.id }],
  });
  expectThrow(
    "cannot apply Customer B's credit beyond invoice outstanding",
    () => {
      // cn2 has $150; make a tiny invoice and try to over-apply against it
      const tiny = storage.createInvoice({
        number: "INV-2002", customerId: custB.id, date: "2026-07-01", dueDate: "2026-08-01",
        taxRate: 0, lines: [{ description: "x", quantity: 1, rate: 100, incomeAccountId: revenue.id }],
      });
      return noteSvc.applyCreditNote(cn2.id, tiny.id, 150);
    },
    /outstanding balance is only/i
  );
  expectThrow(
    "cannot apply a credit note across customers (A's credit → B's invoice)",
    () => {
      const cnA = noteSvc.createCreditNote({
        customerId: custA.id, date: "2026-07-03", reason: "Service not delivered", taxRate: 0,
        lines: [{ description: "Undelivered", quantity: 1, rate: 75, revenueAccountId: revenue.id }],
      });
      return noteSvc.applyCreditNote(cnA.id, invB.id, 75);
    },
    /different customers/i
  );
  expectThrow(
    "cannot void a credit note that has applications",
    () => {
      const partly = noteSvc.applyCreditNote(cn2.id, invB.id, 100);
      return noteSvc.voidCreditNote(partly.creditNote.id, "changed mind");
    },
    /Unapply first/i
  );
  // Unapply, then void succeeds and posts a reversal.
  const app = db.select().from(creditNoteApplications).all() as any[];
  const cn2app = app.find((a) => a.creditNoteId === cn2.id)!;
  noteSvc.unapplyCreditNote(cn2.id, cn2app.id);
  const voided = noteSvc.voidCreditNote(cn2.id, "duplicate entry");
  check("void after unapply succeeds", voided.status === "void");
  const reversal = db.select().from(journalEntries).all().find((e) => e.source === "credit_note_void" && e.sourceId === cn2.id);
  check("void posted a reversing journal entry", !!reversal);

  // ==========================================================================
  console.log("\n[6] Debit note mirror (AP)");
  // ==========================================================================
  const bill = storage.createBill({
    number: "BILL-501",
    vendorId: vendor.id,
    date: "2026-06-20",
    dueDate: "2026-07-20",
    taxRate: 0,
    lines: [{ description: "Paper", quantity: 50, rate: 8, expenseAccountId: expense.id }],
  });
  const dn = noteSvc.createDebitNote({
    vendorId: vendor.id,
    billId: bill.id,
    date: "2026-07-01",
    reason: "Damaged goods returned to vendor",
    taxRate: 0,
    lines: [{ description: "Damaged paper cartons", quantity: 10, rate: 8, expenseAccountId: expense.id }],
  });
  check("debit note number is DN-0001", dn.number === "DN-0001", dn.number);
  check("debit note status is 'sent'", dn.status === "sent");
  const dnJe = db.select().from(journalLines).where(eq(journalLines.entryId, dn.journalEntryId)).all();
  const apLine = dnJe.find((l) => l.accountId === ap.id);
  const expLine = dnJe.find((l) => l.accountId === expense.id);
  check("Dr Accounts Payable $80 (reduces what we owe)", apLine?.debit === 8000 && apLine?.credit === 0);
  check("Cr Expense $80 (reduces the expense)", expLine?.credit === 8000 && expLine?.debit === 0);

  const billBefore = bill.total - bill.amountPaid; // exact
  const dnApplied = noteSvc.applyDebitNote(dn.id, bill.id, 80);
  const billAfter = dnApplied.bill.total - dnApplied.bill.amountPaid; // exact
  console.log(`  bill ${bill.number}: outstanding ${money(billBefore)} → ${money(billAfter)} after applying DN-0001`);
  check("bill outstanding reduced $400 → $320", billBefore === 40000 && billAfter === 32000, `${billBefore} → ${billAfter}`);

  const apAging = storage.apAging("2026-07-05");
  const dn2 = noteSvc.createDebitNote({
    vendorId: vendor.id, date: "2026-07-02", reason: "Short shipment", taxRate: 0,
    lines: [{ description: "Missing box", quantity: 1, rate: 25, expenseAccountId: expense.id }],
  });
  const apAging2 = storage.apAging("2026-07-05");
  const venRow = apAging2.rows.find((r: any) => r.vendorId === vendor.id);
  const dnDetail = venRow?.bills.find((b: any) => b.number === dn2.number);
  check("AP aging shows unapplied DN-0002 as -$25.00", dnDetail?.balance === -2500, String(dnDetail?.balance));
  check("AP aging reconciles with A/P GL balance", !apAging2.warning, apAging2.warning);

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All credit/debit note checks passed ✓");
});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
