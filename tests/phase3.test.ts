/**
 * Phase 3 tests — manual/reversing journals, balance sheet, GL running
 * balance, AR/AP aging, cash flow, bill void.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestOrg, createCustomer, createVendor, accountId, glBalance, storage, db } from "./setup.js";

test("manual JE must balance; unbalanced rejected with exact difference", () => {
  const { orgId, userId } = createTestOrg();
  assert.throws(
    () =>
      storage.createManualJournalEntry(orgId, userId, {
        date: "2026-02-01",
        memo: "bad",
        lines: [
          { accountId: accountId(orgId, "1000"), debit: 1000, credit: 0 },
          { accountId: accountId(orgId, "3000"), debit: 0, credit: 900 },
        ],
      }),
    /does not balance: debits 10\.00 != credits 9\.00/,
  );
  const id = storage.createManualJournalEntry(orgId, userId, {
    date: "2026-02-01",
    memo: "owner capital",
    lines: [
      { accountId: accountId(orgId, "1000"), debit: 500000, credit: 0 },
      { accountId: accountId(orgId, "3000"), debit: 0, credit: 500000 },
    ],
  });
  assert.ok(id > 0);
  assert.equal(glBalance(orgId, "1000"), 500000);
});

test("reverse JE mirrors lines exactly and cannot double-reverse", () => {
  const { orgId, userId } = createTestOrg();
  const id = storage.createManualJournalEntry(orgId, userId, {
    date: "2026-02-01",
    memo: "accrual",
    lines: [
      { accountId: accountId(orgId, "6000"), debit: 12345, credit: 0 },
      { accountId: accountId(orgId, "2000"), debit: 0, credit: 12345 },
    ],
  });
  storage.reverseJournalEntry(orgId, userId, id, "2026-03-01");
  assert.equal(glBalance(orgId, "6000"), 0);
  assert.equal(glBalance(orgId, "2000"), 0);
  assert.throws(() => storage.reverseJournalEntry(orgId, userId, id, "2026-03-02"), /already been reversed/);
});

test("balance sheet balances and rolls P&L into Current earnings", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "BS Co");
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-01-10", dueDate: "2026-02-10",
    lines: [{ description: "svc", quantity: 1, rate: 100000, accountId: accountId(orgId, "4000"), taxRate: 10 }],
  });
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-20", amount: 50000, bankAccountId: accountId(orgId, "1000") });
  const bs = storage.balanceSheet(orgId, "2026-12-31");
  assert.equal(bs.balanced, true);
  assert.equal(bs.assets.total, 110000); // bank 50000 + A/R 60000
  const earnings = bs.equity.rows.find((r) => r.name === "Current earnings");
  assert.ok(earnings);
  assert.equal(earnings!.amount, 100000); // income net of zero expenses
  assert.equal(bs.liabilities.total, 10000); // sales tax payable
});

test("general ledger running balance ties opening + activity = closing", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  storage.createManualJournalEntry(orgId, userId, {
    date: "2026-01-05", memo: "capital",
    lines: [{ accountId: bank, debit: 100000, credit: 0 }, { accountId: accountId(orgId, "3000"), debit: 0, credit: 100000 }],
  });
  storage.createManualJournalEntry(orgId, userId, {
    date: "2026-02-10", memo: "rent",
    lines: [{ accountId: accountId(orgId, "6000"), debit: 30000, credit: 0 }, { accountId: bank, debit: 0, credit: 30000 }],
  });
  const gl = storage.generalLedger(orgId, bank, "2026-02-01", "2026-02-28");
  assert.equal(gl.openingBalance, 100000); // January activity precedes the range
  assert.equal(gl.lines.length, 1);
  assert.equal(gl.lines[0].balance, 70000);
  assert.equal(gl.closingBalance, 70000);
});

test("AR aging buckets by days past due", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Aging Co");
  const sales = accountId(orgId, "4000");
  const mk = (date: string, due: string, cents: number) =>
    storage.createInvoice(orgId, userId, {
      customerId, date, dueDate: due,
      lines: [{ description: "x", quantity: 1, rate: cents, accountId: sales, taxRate: 0 }],
    });
  mk("2026-06-01", "2026-07-15", 10000); // not yet due at 2026-07-01 → current
  mk("2026-05-01", "2026-06-15", 20000); // 16 days past → 1-30
  mk("2026-01-01", "2026-02-01", 30000); // 150 days past → 90+
  const rows = storage.arAging(orgId, "2026-07-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].current, 10000);
  assert.equal(rows[0].d1_30, 20000);
  assert.equal(rows[0].d90_plus, 30000);
  assert.equal(rows[0].total, 60000);
});

test("cash flow: opening + receipts - payments = closing across bank accounts", () => {
  const { orgId, userId } = createTestOrg();
  const bank = accountId(orgId, "1000");
  storage.createManualJournalEntry(orgId, userId, {
    date: "2025-12-15", memo: "prior-year capital",
    lines: [{ accountId: bank, debit: 500000, credit: 0 }, { accountId: accountId(orgId, "3000"), debit: 0, credit: 500000 }],
  });
  const customerId = createCustomer(orgId, "Cash Co");
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-01-10", dueDate: "2026-02-10",
    lines: [{ description: "svc", quantity: 1, rate: 80000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-15", amount: 80000, bankAccountId: bank });
  const vendorId = createVendor(orgId, "Cash Vendor");
  const bill = storage.createBill(orgId, userId, {
    vendorId, date: "2026-01-12", dueDate: "2026-02-12",
    lines: [{ description: "supplies", quantity: 1, rate: 30000, accountId: accountId(orgId, "6000"), taxRate: 0 }],
  });
  storage.payBill(orgId, userId, bill.id, { date: "2026-01-20", amount: 30000, bankAccountId: bank });
  const cf = storage.cashFlow(orgId, "2026-01-01", "2026-12-31");
  assert.equal(cf.openingCash, 500000);
  assert.equal(cf.receipts, 80000);
  assert.equal(cf.payments, 30000);
  assert.equal(cf.closingCash, 550000);
  assert.equal(cf.closingCash, glBalance(orgId, "1000"));
});

test("voidBill reverses the posting and blocks paid bills", () => {
  const { orgId, userId } = createTestOrg();
  const vendorId = createVendor(orgId, "Void Vendor");
  const bill = storage.createBill(orgId, userId, {
    vendorId, date: "2026-01-10", dueDate: "2026-02-10",
    lines: [{ description: "x", quantity: 1, rate: 40000, accountId: accountId(orgId, "6000"), taxRate: 0 }],
  });
  assert.equal(glBalance(orgId, "2000"), -40000);
  storage.voidBill(orgId, userId, bill.id);
  assert.equal(glBalance(orgId, "2000"), 0);
  assert.equal(glBalance(orgId, "6000"), 0);
  assert.equal(storage.getBill(orgId, bill.id).status, "void");

  const bill2 = storage.createBill(orgId, userId, {
    vendorId, date: "2026-01-11", dueDate: "2026-02-11",
    lines: [{ description: "y", quantity: 1, rate: 10000, accountId: accountId(orgId, "6000"), taxRate: 0 }],
  });
  storage.payBill(orgId, userId, bill2.id, { date: "2026-01-20", amount: 10000, bankAccountId: accountId(orgId, "1000") });
  assert.throws(() => storage.voidBill(orgId, userId, bill2.id), /payments applied/);
  void db;
});
