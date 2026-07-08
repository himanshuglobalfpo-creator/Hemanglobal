/**
 * Phase 5 tests — bank reconciliation engine.
 * Covers: duplicate imports, partial-payment matches, one deposit to many
 * invoices, splits with merchant fees, transfers, voided checks,
 * outstanding checks, deposits in transit, and the ending-balance identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestOrg, createCustomer, createVendor, accountId, glBalance, storage, db } from "./setup.js";
import { importBankTransactions } from "../server/importers.js";
import {
  suggestMatches, matchBankTransaction, unmatchBankTransaction, excludeBankTransaction,
  categorizeBankTransaction, reconcileAccount,
} from "../server/bank.js";

const csv = (...rows: string[]) => ["date,description,amount", ...rows].join("\n");

function txIds(orgId: number, accountId: number): Array<{ id: number; amount: number; status: string; description: string }> {
  return db
    .prepare("SELECT id, amount, status, description FROM bank_transactions WHERE org_id = ? AND account_id = ? ORDER BY id")
    .all(orgId, accountId) as Array<{ id: number; amount: number; status: string; description: string }>;
}

test("imported bank files: re-import skips duplicates; legit in-file twins allowed", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  // Two IDENTICAL coffee charges in one file are legitimate.
  const file = csv("2026-04-01,Coffee,-4.50", "2026-04-01,Coffee,-4.50", "2026-04-02,Deposit,100.00");
  const first = importBankTransactions(orgId, userId, bank, file, false);
  assert.equal(first.inserted, 3);
  assert.equal(first.skipped, 0);
  // Re-importing the same file must be a complete no-op.
  const again = importBankTransactions(orgId, userId, bank, file, false);
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, 3);
  // A THIRD same-day coffee in a new file is new data (2 exist, file has 3).
  const extended = importBankTransactions(
    orgId, userId, bank,
    csv("2026-04-01,Coffee,-4.50", "2026-04-01,Coffee,-4.50", "2026-04-01,Coffee,-4.50"), false,
  );
  assert.equal(extended.inserted, 1);
  assert.equal(extended.skipped, 2);
});

test("partial match: statement line clears a PARTIAL payment JE exactly", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  const customerId = createCustomer(orgId, "Partial Co");
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-04-01", dueDate: "2026-05-01",
    lines: [{ description: "svc", quantity: 1, rate: 100000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-04-10", amount: 40000, bankAccountId: bank });
  importBankTransactions(orgId, userId, bank, csv("2026-04-10,Partial payment,400.00"), false);
  const [tx] = txIds(orgId, bank);
  const suggestions = suggestMatches(orgId, bank);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].candidates.length, 1); // finds the partial-payment JE
  matchBankTransaction(orgId, userId, tx.id, [suggestions[0].candidates[0].entryId]);
  assert.equal(txIds(orgId, bank)[0].status, "matched");
  // Mismatched amount is rejected with both figures.
  importBankTransactions(orgId, userId, bank, csv("2026-04-11,Wrong amount,350.00"), false);
  const wrong = txIds(orgId, bank)[1];
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-04-11", amount: 30000, bankAccountId: bank });
  const je = db.prepare("SELECT id FROM journal_entries WHERE org_id = ? AND source='invoice_payment' ORDER BY id DESC LIMIT 1").get(orgId) as { id: number };
  assert.throws(() => matchBankTransaction(orgId, userId, wrong.id, [je.id]), /300\.00.*350\.00|amounts must match/);
});

test("multiple invoices: one deposit clears several payment JEs", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  const customerId = createCustomer(orgId, "Bulk Payer");
  const sales = accountId(orgId, "4000");
  const jeIds: number[] = [];
  for (const cents of [25000, 35000]) {
    const inv = storage.createInvoice(orgId, userId, {
      customerId, date: "2026-04-01", dueDate: "2026-05-01",
      lines: [{ description: "x", quantity: 1, rate: cents, accountId: sales, taxRate: 0 }],
    });
    storage.payInvoice(orgId, userId, inv.id, { date: "2026-04-15", amount: cents, bankAccountId: bank });
    jeIds.push((db.prepare("SELECT id FROM journal_entries WHERE org_id=? AND source='invoice_payment' AND source_id=?").get(orgId, inv.id) as { id: number }).id);
  }
  importBankTransactions(orgId, userId, bank, csv("2026-04-15,Combined deposit,600.00"), false);
  const [tx] = txIds(orgId, bank);
  matchBankTransaction(orgId, userId, tx.id, jeIds); // 250 + 350 = 600 ✓
  assert.equal(txIds(orgId, bank)[0].status, "matched");
  // Same entry cannot be cleared twice.
  importBankTransactions(orgId, userId, bank, csv("2026-04-16,Duplicate attempt,250.00"), false);
  const dup = txIds(orgId, bank)[1];
  assert.throws(() => matchBankTransaction(orgId, userId, dup.id, [jeIds[0]]), /already cleared/);
});

test("split transaction with merchant fee: +$96.80 = $100 sales - $3.20 fees", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  importBankTransactions(orgId, userId, bank, csv("2026-04-20,Card settlement,96.80"), false);
  const [tx] = txIds(orgId, bank);
  const entryId = categorizeBankTransaction(orgId, userId, tx.id, "Card settlement w/ fee", [
    { accountId: accountId(orgId, "4000"), amount: 10000 },  // gross sales
    { accountId: accountId(orgId, "6000"), amount: -320 },   // merchant fee
  ]);
  assert.ok(entryId > 0);
  assert.equal(glBalance(orgId, "1000"), 9680);
  assert.equal(glBalance(orgId, "4000"), -10000);
  assert.equal(glBalance(orgId, "6000"), 320);
  assert.equal(txIds(orgId, bank)[0].status, "matched");
  // splits that don't sum to the line are rejected
  importBankTransactions(orgId, userId, bank, csv("2026-04-21,Bad split,50.00"), false);
  const bad = txIds(orgId, bank)[1];
  assert.throws(
    () => categorizeBankTransaction(orgId, userId, bad.id, "", [{ accountId: accountId(orgId, "4000"), amount: 4900 }]),
    /splits sum to 49\.00/,
  );
});

test("transfer: one JE clears the outflow AND the inflow statement lines", () => {
  const { orgId, userId } = createTestOrg();
  const checking = accountId(orgId, "1000");
  const r = db.prepare("INSERT INTO accounts (org_id, code, name, type, subtype) VALUES (?,?,?,?,?)")
    .run(orgId, "1010", "Savings", "asset", "bank");
  const savings = Number(r.lastInsertRowid);
  importBankTransactions(orgId, userId, checking, csv("2026-04-22,Transfer to savings,-250.00"), false);
  importBankTransactions(orgId, userId, savings, csv("2026-04-22,Transfer from checking,250.00"), false);
  const [outTx] = txIds(orgId, checking);
  const [inTx] = txIds(orgId, savings);
  // Categorize the checking side entirely into savings → JE: DR savings / CR checking.
  const entryId = categorizeBankTransaction(orgId, userId, outTx.id, "Transfer", [{ accountId: savings, amount: -25000 }]);
  // The savings-side statement line matches that SAME entry (+250 on savings).
  matchBankTransaction(orgId, userId, inTx.id, [entryId]);
  assert.equal(txIds(orgId, checking)[0].status, "matched");
  assert.equal(txIds(orgId, savings)[0].status, "matched");
  assert.equal(glBalance(orgId, "1000"), -25000);
  assert.equal(glBalance(orgId, "1010"), 25000);
});

test("reconciliation: outstanding checks, deposits in transit, voided check, ending balance", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  const vendorId = createVendor(orgId, "Payee Co");
  const customerId = createCustomer(orgId, "Depositor");
  const sales = accountId(orgId, "4000");
  const expense = accountId(orgId, "6000");

  // Opening funds: $1,000 capital (will be matched).
  const capitalJe = storage.createManualJournalEntry(orgId, userId, {
    date: "2026-04-01", memo: "capital",
    lines: [{ accountId: bank, debit: 100000, credit: 0 }, { accountId: accountId(orgId, "3000"), debit: 0, credit: 100000 }],
  });

  // Check #101: $150 to vendor — WILL clear on the statement.
  const bill1 = storage.createBill(orgId, userId, {
    vendorId, date: "2026-04-02", dueDate: "2026-05-02",
    lines: [{ description: "supplies", quantity: 1, rate: 15000, accountId: expense, taxRate: 0 }],
  });
  storage.payBill(orgId, userId, bill1.id, { date: "2026-04-05", amount: 15000, bankAccountId: bank });
  const check101 = (db.prepare("SELECT id FROM journal_entries WHERE org_id=? AND source='bill_payment' AND source_id=?").get(orgId, bill1.id) as { id: number }).id;

  // Check #102: $200 — OUTSTANDING (never hits the statement).
  const bill2 = storage.createBill(orgId, userId, {
    vendorId, date: "2026-04-03", dueDate: "2026-05-03",
    lines: [{ description: "more supplies", quantity: 1, rate: 20000, accountId: expense, taxRate: 0 }],
  });
  storage.payBill(orgId, userId, bill2.id, { date: "2026-04-20", amount: 20000, bankAccountId: bank });

  // Deposit in transit: $300 received 04-29, not on statement yet.
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-04-10", dueDate: "2026-05-10",
    lines: [{ description: "svc", quantity: 1, rate: 30000, accountId: sales, taxRate: 0 }],
  });
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-04-29", amount: 30000, bankAccountId: bank });

  // Voided check: manual JE check then reversal — both unmatched, net zero.
  const voided = storage.createManualJournalEntry(orgId, userId, {
    date: "2026-04-12", memo: "check #103 (voided later)",
    lines: [{ accountId: expense, debit: 5000, credit: 0 }, { accountId: bank, debit: 0, credit: 5000 }],
  });
  storage.reverseJournalEntry(orgId, userId, voided, "2026-04-13");

  // Statement: capital in, check #101 out → ending balance $850.
  importBankTransactions(orgId, userId, bank, csv(
    "2026-04-01,Opening deposit,1000.00",
    "2026-04-05,Check 101,-150.00",
  ), false);
  const [capTx, chkTx] = txIds(orgId, bank);
  matchBankTransaction(orgId, userId, capTx.id, [capitalJe]);
  matchBankTransaction(orgId, userId, chkTx.id, [check101]);

  const rep = reconcileAccount(orgId, userId, bank, "2026-04-30", 85000, false);
  assert.equal(rep.clearedBalance, 85000, "cleared = matched activity only");
  assert.equal(rep.outstandingChecks, 20000 + 5000, "check #102 + voided check original");
  assert.equal(rep.depositsInTransit, 30000 + 5000, "deposit in transit + void reversal");
  // Voided check contributes +5000/-5000 — nets to zero in the identity:
  assert.equal(rep.statementEndingBalance + rep.depositsInTransit - rep.outstandingChecks, rep.ledgerBalance);
  assert.equal(rep.ledgerBalance, glBalance(orgId, "1000"));
  assert.equal(rep.difference, 0);
  assert.equal(rep.reconciled, true);

  // Wrong statement balance → nonzero difference, completion refused.
  const bad = reconcileAccount(orgId, userId, bank, "2026-04-30", 90000, false);
  assert.equal(bad.difference, 5000);
  assert.equal(bad.reconciled, false);
  assert.throws(() => reconcileAccount(orgId, userId, bank, "2026-04-30", 90000, true), /difference of 50\.00/);

  // Correct completion persists a reconciliation row.
  reconcileAccount(orgId, userId, bank, "2026-04-30", 85000, true);
  const saved = db.prepare("SELECT * FROM reconciliations WHERE org_id = ? AND account_id = ?").all(orgId, bank);
  assert.equal(saved.length, 1);
});

test("duplicate statement line can be excluded and unmatch restores state", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  importBankTransactions(orgId, userId, bank, csv("2026-04-25,Bank error duplicate,-10.00"), false);
  const [tx] = txIds(orgId, bank);
  excludeBankTransaction(orgId, userId, tx.id);
  assert.equal(txIds(orgId, bank)[0].status, "excluded");
  // Excluded lines don't appear in reconciliation's unmatched list.
  const rep = reconcileAccount(orgId, userId, bank, "2026-04-30", 0, false);
  assert.equal(rep.unmatchedBankLines.length, 0);
  // Categorize + unmatch round-trip.
  importBankTransactions(orgId, userId, bank, csv("2026-04-26,Fee,-15.00"), false);
  const fee = txIds(orgId, bank)[1];
  categorizeBankTransaction(orgId, userId, fee.id, "bank fee", [{ accountId: accountId(orgId, "6000"), amount: -1500 }]);
  assert.equal(txIds(orgId, bank)[1].status, "matched");
  unmatchBankTransaction(orgId, userId, fee.id);
  assert.equal(txIds(orgId, bank)[1].status, "unmatched");
});

test("cross-org isolation: cannot match another org's entry or transaction", () => {
  const a = createTestOrg();
  const b = createTestOrg();
  const bankA = accountId(a.orgId, "1000");
  importBankTransactions(a.orgId, a.userId, bankA, csv("2026-04-27,Deposit,50.00"), false);
  const [tx] = txIds(a.orgId, bankA);
  const jeB = storage.createManualJournalEntry(b.orgId, b.userId, {
    date: "2026-04-27", memo: "other org",
    lines: [
      { accountId: accountId(b.orgId, "1000"), debit: 5000, credit: 0 },
      { accountId: accountId(b.orgId, "3000"), debit: 0, credit: 5000 },
    ],
  });
  assert.throws(() => matchBankTransaction(a.orgId, a.userId, tx.id, [jeB]), /not found/);
  assert.throws(() => matchBankTransaction(b.orgId, b.userId, tx.id, [jeB]), /not found/);
});
