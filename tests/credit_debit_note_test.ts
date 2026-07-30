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
// Postgres harness (same as the other integration tests): uses $DATABASE_URL
// if set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/credit_debit_note_test.ts
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const money = (n: number) => `$${(n / 100).toFixed(2)}`; // cents → display

async function main() {
  async function expectReject(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
    try {
      await fn();
      failures++;
      console.error(`  ✗ ${label} — expected an error, none thrown`);
    } catch (e: any) {
      check(label, pattern.test(String(e?.message)), `got: ${e?.message}`);
    }
  }

  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("credit_debit_note");
  try {
    const noteSvc = await import("../server/creditNoteService");
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Notes Co', 'notes-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('n@n.test', 'x', 'Notes Tester')`);
    await seedOrgDefaults(1);

    // Ledger inspection helpers (raw SQL — org 1 is the only tenant here).
    const jeLinesFor = async (entryId: number) =>
      (await pool.query(
        `SELECT jl.account_id AS "accountId", jl.debit, jl.credit, a.code, a.name, a.subtype
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = $1`,
        [entryId]
      )).rows as Array<{ accountId: number; debit: number; credit: number; code: string; name: string; subtype: string | null }>;

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const accts = await storage.listAccounts();
      const ar = accts.find((a) => a.code === "1100")!;
      const ap = accts.find((a) => a.code === "2000")!;
      const revenue = accts.find((a) => a.type === "income")!;
      const expense = accts.find((a) => a.type === "expense")!;

      const custA = await storage.createCustomer({ name: "Acme Corp" } as any);
      const custB = await storage.createCustomer({ name: "Beta LLC" } as any);
      const vendor = await storage.createVendor({ name: "Office Supplies Inc" } as any);

      // ========================================================================
      console.log("\n[1] $200 credit note posts the correct GL entry");
      // ========================================================================
      const cn = await noteSvc.createCreditNote({
        customerId: custA.id,
        date: "2026-07-01",
        reason: "Goods returned",
        taxRate: 0,
        lines: [{ description: "Returned widgets", quantity: 2, rate: 100, revenueAccountId: revenue.id }],
      } as any);
      check("credit note number is CN-0001", cn.number === "CN-0001", cn.number);
      check("status is 'issued'", cn.status === "issued", cn.status);
      check("total is $200.00", cn.total === 20000, money(cn.total));
      check("remainingCredit is $200.00", cn.remainingCredit === 20000, money(cn.remainingCredit));

      const jeLines = await jeLinesFor(cn.journalEntryId);
      const revLine = jeLines.find((l) => l.accountId === revenue.id);
      const arLine = jeLines.find((l) => l.accountId === ar.id);
      check("Dr Revenue $200 (reduces revenue)", revLine?.debit === 20000 && revLine?.credit === 0);
      check("Cr Accounts Receivable $200", arLine?.credit === 20000 && arLine?.debit === 0);
      check("no Cash account touched", jeLines.every((l) => l.subtype !== "bank"));
      const drTotal = jeLines.reduce((s, l) => s + l.debit, 0);
      const crTotal = jeLines.reduce((s, l) => s + l.credit, 0);
      check("entry balances (Dr = Cr)", drTotal === crTotal);

      // ========================================================================
      console.log("\n[2] Apply $200 credit to a $1,000 invoice → outstanding $800");
      // ========================================================================
      const inv = await storage.createInvoice({
        number: "INV-1001", customerId: custA.id, date: "2026-06-15", dueDate: "2026-07-15",
        taxRate: 0, lines: [{ description: "Consulting", quantity: 10, rate: 100, incomeAccountId: revenue.id }],
      } as any);
      const before = inv.total - inv.amountPaid;
      check("invoice outstanding before = $1,000.00", before === 100000);

      const applied = await noteSvc.applyCreditNote(cn.id, inv.id, 200);
      const after = applied.invoice.total - applied.invoice.amountPaid;
      check("invoice outstanding after = $800.00", after === 80000, money(after));
      check("credit note appliedAmount = $200.00", applied.creditNote.appliedAmount === 20000);
      check("credit note remainingCredit = $0.00", applied.creditNote.remainingCredit === 0);
      check("credit note status flips to 'applied'", applied.creditNote.status === "applied");
      const applyJeCount = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM journal_entries WHERE org_id = 1 AND source = 'credit_note_application'`
      )).rows[0].c as number;
      check("application posted NO new journal entry", applyJeCount === 0);

      // ========================================================================
      console.log("\n[3] AR aging shows unapplied credit notes as negative balances");
      // ========================================================================
      const cn2 = await noteSvc.createCreditNote({
        customerId: custB.id, date: "2026-07-02", reason: "Pricing error", taxRate: 0,
        lines: [{ description: "Overbilled hours", quantity: 1, rate: 150, revenueAccountId: revenue.id }],
      } as any);
      check("second credit note is CN-0002", cn2.number === "CN-0002", cn2.number);
      const aging = await storage.arAging("2026-07-05");
      const betaRow = aging.rows.find((r: any) => r.customerId === custB.id);
      check("Beta LLC shows NEGATIVE -$150.00 (unapplied credit)", betaRow?.total === -15000, money(betaRow?.total ?? 0));
      const cnDetail = betaRow?.invoices.find((i: any) => i.number === "CN-0002");
      check("CN-0002 appears in the row detail with negative balance", cnDetail?.balance === -15000);
      check("aging total reconciles with A/R GL balance", !aging.warning, aging.warning);

      // ========================================================================
      console.log("\n[4] Trial balance still balances (GL flow verified)");
      // ========================================================================
      const tb = await storage.trialBalance("2026-07-05");
      check("trial balance Dr = Cr", tb.totalDebit === tb.totalCredit, `Dr ${tb.totalDebit} vs Cr ${tb.totalCredit}`);

      // ========================================================================
      console.log("\n[5] Business rules enforced");
      // ========================================================================
      await expectReject(
        "cannot apply more than remaining credit",
        () => noteSvc.applyCreditNote(cn.id, inv.id, 50),
        /\$0\.00 remaining|remaining/i
      );
      const invB = await storage.createInvoice({
        number: "INV-2001", customerId: custB.id, date: "2026-07-01", dueDate: "2026-08-01",
        taxRate: 0, lines: [{ description: "Design", quantity: 1, rate: 500, incomeAccountId: revenue.id }],
      } as any);
      await expectReject(
        "cannot apply Customer B's credit beyond invoice outstanding",
        async () => {
          const tiny = await storage.createInvoice({
            number: "INV-2002", customerId: custB.id, date: "2026-07-01", dueDate: "2026-08-01",
            taxRate: 0, lines: [{ description: "x", quantity: 1, rate: 100, incomeAccountId: revenue.id }],
          } as any);
          return noteSvc.applyCreditNote(cn2.id, tiny.id, 150);
        },
        /outstanding balance is only/i
      );
      await expectReject(
        "cannot apply a credit note across customers (A's credit → B's invoice)",
        async () => {
          const cnA = await noteSvc.createCreditNote({
            customerId: custA.id, date: "2026-07-03", reason: "Service not delivered", taxRate: 0,
            lines: [{ description: "Undelivered", quantity: 1, rate: 75, revenueAccountId: revenue.id }],
          } as any);
          return noteSvc.applyCreditNote(cnA.id, invB.id, 75);
        },
        /different customers/i
      );
      await expectReject(
        "cannot void a credit note that has applications",
        async () => {
          const partly = await noteSvc.applyCreditNote(cn2.id, invB.id, 100);
          return noteSvc.voidCreditNote(partly.creditNote.id, "changed mind");
        },
        /Unapply first/i
      );
      // Unapply, then void succeeds and posts a reversal.
      const cn2app = (await pool.query(
        `SELECT id FROM credit_note_applications WHERE org_id = 1 AND credit_note_id = $1 LIMIT 1`, [cn2.id]
      )).rows[0] as { id: number };
      await noteSvc.unapplyCreditNote(cn2.id, cn2app.id);
      const voided = await noteSvc.voidCreditNote(cn2.id, "duplicate entry");
      check("void after unapply succeeds", voided.status === "void");
      const reversal = (await pool.query(
        `SELECT id FROM journal_entries WHERE org_id = 1 AND source = 'credit_note_void' AND source_id = $1`, [cn2.id]
      )).rows[0];
      check("void posted a reversing journal entry", !!reversal);

      // ========================================================================
      console.log("\n[6] Debit note mirror (AP)");
      // ========================================================================
      const bill = await storage.createBill({
        number: "BILL-501", vendorId: vendor.id, date: "2026-06-20", dueDate: "2026-07-20",
        taxRate: 0, lines: [{ description: "Paper", quantity: 50, rate: 8, expenseAccountId: expense.id }],
      } as any);
      const dn = await noteSvc.createDebitNote({
        vendorId: vendor.id, billId: bill.id, date: "2026-07-01",
        reason: "Damaged goods returned to vendor", taxRate: 0,
        lines: [{ description: "Damaged paper cartons", quantity: 10, rate: 8, expenseAccountId: expense.id }],
      } as any);
      check("debit note number is DN-0001", dn.number === "DN-0001", dn.number);
      check("debit note status is 'sent'", dn.status === "sent");
      const dnJe = await jeLinesFor(dn.journalEntryId);
      const apLine = dnJe.find((l) => l.accountId === ap.id);
      const expLine = dnJe.find((l) => l.accountId === expense.id);
      check("Dr Accounts Payable $80 (reduces what we owe)", apLine?.debit === 8000 && apLine?.credit === 0);
      check("Cr Expense $80 (reduces the expense)", expLine?.credit === 8000 && expLine?.debit === 0);

      const billBefore = bill.total - bill.amountPaid;
      const dnApplied = await noteSvc.applyDebitNote(dn.id, bill.id, 80);
      const billAfter = dnApplied.bill.total - dnApplied.bill.amountPaid;
      check("bill outstanding reduced $400 → $320", billBefore === 40000 && billAfter === 32000, `${billBefore} → ${billAfter}`);

      const dn2 = await noteSvc.createDebitNote({
        vendorId: vendor.id, date: "2026-07-02", reason: "Short shipment", taxRate: 0,
        lines: [{ description: "Missing box", quantity: 1, rate: 25, expenseAccountId: expense.id }],
      } as any);
      const apAging2 = await storage.apAging("2026-07-05");
      const venRow = apAging2.rows.find((r: any) => r.vendorId === vendor.id);
      const dnDetail = venRow?.bills.find((b: any) => b.number === dn2.number);
      check("AP aging shows unapplied DN-0002 as -$25.00", dnDetail?.balance === -2500, String(dnDetail?.balance));
      check("AP aging reconciles with A/P GL balance", !apAging2.warning, apAging2.warning);
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All credit/debit note checks passed ✓");
}

main().catch((e) => { console.error(e); process.exit(1); });
