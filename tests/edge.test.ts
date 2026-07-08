/**
 * Phase 6 tests — edge cases.
 * Negative/zero documents & payments, deleted parties, closed periods,
 * future/past dates, duplicate numbers/payments, large amounts, FX edges,
 * tax rounding discipline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestOrg, createCustomer, createVendor, accountId, glBalance, storage, db } from "./setup.js";
import { insertInvoiceSchema, paymentSchema } from "../shared/schema.js";

test("negative invoice: negative rate and negative quantity are rejected by validation", () => {
  const base = { customerId: 1, date: "2026-01-01", dueDate: "2026-01-31" };
  assert.equal(insertInvoiceSchema.safeParse({ ...base, lines: [{ description: "x", quantity: 1, rate: -100, accountId: 1, taxRate: 0 }] }).success, false);
  assert.equal(insertInvoiceSchema.safeParse({ ...base, lines: [{ description: "x", quantity: -1, rate: 100, accountId: 1, taxRate: 0 }] }).success, false);
  assert.equal(insertInvoiceSchema.safeParse({ ...base, lines: [{ description: "x", quantity: 1, rate: 100.5, accountId: 1, taxRate: 0 }] }).success, false); // non-integer cents
});

test("negative and zero payments are rejected", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Pay Edge");
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "x", quantity: 1, rate: 10000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  // negative rejected at the schema layer
  assert.equal(paymentSchema.safeParse({ date: "2026-01-06", amount: -100, bankAccountId: 1 }).success, false);
  // zero rejected at the business layer with the outstanding shown
  assert.throws(
    () => storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-06", amount: 0, bankAccountId: accountId(orgId, "1000") }),
    /amount must be 1\.\.10000/,
  );
});

test("deleted (deactivated) customer cannot be invoiced; history survives", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Ghost Co");
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "pre-delete", quantity: 1, rate: 5000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  db.prepare("UPDATE customers SET is_active = 0 WHERE id = ?").run(customerId); // soft delete
  assert.throws(
    () => storage.createInvoice(orgId, userId, {
      customerId, date: "2026-01-06", dueDate: "2026-02-06",
      lines: [{ description: "post-delete", quantity: 1, rate: 5000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
    }),
    /deactivated/,
  );
  // history intact: the earlier invoice still reads and pays fine
  assert.equal(storage.getInvoice(orgId, inv.id).total, 5000);
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-10", amount: 5000, bankAccountId: accountId(orgId, "1000") });
  assert.equal(storage.getInvoice(orgId, inv.id).status, "paid");
});

test("deleted (deactivated) vendor cannot be billed", () => {
  const { orgId, userId } = createTestOrg();
  const vendorId = createVendor(orgId, "Gone Vendor");
  db.prepare("UPDATE vendors SET is_active = 0 WHERE id = ?").run(vendorId);
  assert.throws(
    () => storage.createBill(orgId, userId, {
      vendorId, date: "2026-01-06", dueDate: "2026-02-06",
      lines: [{ description: "x", quantity: 1, rate: 5000, accountId: accountId(orgId, "6000"), taxRate: 0 }],
    }),
    /deactivated/,
  );
});

test("closed accounting period blocks every posting path", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Period Co");
  const inv = storage.createInvoice(orgId, userId, {
    customerId, date: "2026-01-15", dueDate: "2026-02-15",
    lines: [{ description: "open period", quantity: 1, rate: 10000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  db.prepare("INSERT INTO closed_periods (org_id, through_date) VALUES (?, '2026-03-31')").run(orgId);
  const closedDate = { date: "2026-02-01", dueDate: "2026-03-01" };
  assert.throws(() => storage.createInvoice(orgId, userId, {
    customerId, ...closedDate,
    lines: [{ description: "x", quantity: 1, rate: 100, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  }), /period closed through 2026-03-31/);
  assert.throws(() => storage.payInvoice(orgId, userId, inv.id, { date: "2026-03-15", amount: 100, bankAccountId: accountId(orgId, "1000") }), /period closed/);
  assert.throws(() => storage.createManualJournalEntry(orgId, userId, {
    date: "2026-03-01", memo: "x",
    lines: [{ accountId: accountId(orgId, "1000"), debit: 100, credit: 0 }, { accountId: accountId(orgId, "3000"), debit: 0, credit: 100 }],
  }), /period closed/);
  // posting AFTER the closed period is fine
  const ok = storage.payInvoice(orgId, userId, inv.id, { date: "2026-04-01", amount: 10000, bankAccountId: accountId(orgId, "1000") });
  assert.equal(ok.status, "paid");
});

test("future and past dates post normally in open periods and bucket correctly", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Time Co");
  const sales = accountId(orgId, "4000");
  storage.createInvoice(orgId, userId, { customerId, date: "2030-12-31", dueDate: "2031-01-31",
    lines: [{ description: "future", quantity: 1, rate: 1000, accountId: sales, taxRate: 0 }] });
  storage.createInvoice(orgId, userId, { customerId, date: "2001-01-01", dueDate: "2001-02-01",
    lines: [{ description: "ancient", quantity: 1, rate: 2000, accountId: sales, taxRate: 0 }] });
  const pl = storage.profitLossMonthly(orgId, "2001-01-01", "2030-12-31");
  assert.ok(pl.months.includes("2030-12"));
  assert.ok(pl.months.includes("2001-01"));
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
  // impossible calendar dates are rejected upstream by Zod
  assert.equal(insertInvoiceSchema.safeParse({ customerId, date: "2026-02-30", dueDate: "2026-03-30",
    lines: [{ description: "x", quantity: 1, rate: 100, accountId: sales, taxRate: 0 }] }).success, false);
});

test("duplicate invoice/bill number gets a clean 409, not a DB constraint blowup", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Numbered");
  const vendorId = createVendor(orgId, "NumberedV");
  const sales = accountId(orgId, "4000");
  storage.createInvoice(orgId, userId, { customerId, number: "INV-DUP", date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "x", quantity: 1, rate: 100, accountId: sales, taxRate: 0 }] });
  assert.throws(() => storage.createInvoice(orgId, userId, { customerId, number: "INV-DUP", date: "2026-01-06", dueDate: "2026-02-06",
    lines: [{ description: "y", quantity: 1, rate: 100, accountId: sales, taxRate: 0 }] }), /INV-DUP already exists/);
  storage.createBill(orgId, userId, { vendorId, number: "BILL-DUP", date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "x", quantity: 1, rate: 100, accountId: accountId(orgId, "6000"), taxRate: 0 }] });
  assert.throws(() => storage.createBill(orgId, userId, { vendorId, number: "BILL-DUP", date: "2026-01-06", dueDate: "2026-02-06",
    lines: [{ description: "y", quantity: 1, rate: 100, accountId: accountId(orgId, "6000"), taxRate: 0 }] }), /BILL-DUP already exists/);
  // same number in ANOTHER org is fine (org-scoped uniqueness)
  const other = createTestOrg();
  const c2 = createCustomer(other.orgId, "Other Numbered");
  const inv2 = storage.createInvoice(other.orgId, other.userId, { customerId: c2, number: "INV-DUP", date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "x", quantity: 1, rate: 100, accountId: accountId(other.orgId, "4000"), taxRate: 0 }] });
  assert.equal(inv2.number, "INV-DUP");
});

test("duplicate payment: second full payment rejected; over-tender rejected", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Double Pay");
  const inv = storage.createInvoice(orgId, userId, { customerId, date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "x", quantity: 1, rate: 10000, accountId: accountId(orgId, "4000"), taxRate: 0 }] });
  const bank = accountId(orgId, "1000");
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-10", amount: 10000, bankAccountId: bank });
  assert.throws(() => storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-11", amount: 10000, bankAccountId: bank }), /already paid/);
  assert.equal(glBalance(orgId, "1100"), 0); // A/R untouched by the rejected retry
});

test("zero-amount invoice and zero journal are rejected with clear messages", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Zero Co");
  assert.throws(() => storage.createInvoice(orgId, userId, { customerId, date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "free", quantity: 1, rate: 0, accountId: accountId(orgId, "4000"), taxRate: 0 }] }),
    /total must be greater than zero/);
  assert.throws(() => storage.createManualJournalEntry(orgId, userId, { date: "2026-01-05", memo: "zero",
    lines: [{ accountId: accountId(orgId, "1000"), debit: 0, credit: 0 }, { accountId: accountId(orgId, "3000"), debit: 0, credit: 0 }] }),
    /amount must be greater than zero/);
});

test("large amounts: $10B invoice round-trips exactly (integer-cent safe range)", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Mega Corp");
  const rate = 99_999_999_999; // $999,999,999.99 per unit
  const inv = storage.createInvoice(orgId, userId, { customerId, date: "2026-01-05", dueDate: "2026-02-05",
    lines: [{ description: "acquisition", quantity: 10, rate, accountId: accountId(orgId, "4000"), taxRate: 0 }] });
  assert.equal(inv.total, 999_999_999_990); // ~$10B in cents, far below 2^53
  storage.payInvoice(orgId, userId, inv.id, { date: "2026-01-10", amount: inv.total, bankAccountId: accountId(orgId, "1000") });
  assert.equal(glBalance(orgId, "1000"), 999_999_999_990);
  assert.equal(glBalance(orgId, "1100"), 0);
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});

test("foreign currency edges: explicit base currency treated as base; tiny fx rate", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "Edge FX");
  // explicitly passing the org base currency must NOT create an FX document
  const inv = storage.createInvoice(orgId, userId, { customerId, date: "2026-01-05", dueDate: "2026-02-05",
    currency: "USD", lines: [{ description: "x", quantity: 1, rate: 10000, accountId: accountId(orgId, "4000"), taxRate: 0 }] });
  assert.equal(inv.currency, "");
  assert.equal(inv.fx_rate, 1);
  // extreme-but-valid rate (e.g. IDR-like) still balances
  const c2 = createCustomer(orgId, "Tiny Rate", "JPY");
  const inv2 = storage.createInvoice(orgId, userId, { customerId: c2, date: "2026-01-05", dueDate: "2026-02-05",
    currency: "JPY", fxRate: 0.0067,
    lines: [{ description: "tokyo", quantity: 1, rate: 1_000_000, accountId: accountId(orgId, "4000"), taxRate: 0 }] });
  assert.equal(inv2.total, Math.round(1_000_000 * 0.0067)); // 6700¢ = $67.00
  storage.payInvoice(orgId, userId, inv2.id, { date: "2026-01-20", foreignAmount: 1_000_000, fxRate: 0.0071, bankAccountId: accountId(orgId, "1000") });
  assert.equal(glBalance(orgId, "4950"), -400); // $4.00 FX gain
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});

test("tax rounding: per-line round-half-up; invoice.tax always equals sum of line taxes", () => {
  const { orgId, userId } = createTestOrg();
  const customerId = createCustomer(orgId, "Tax Edge");
  const sales = accountId(orgId, "4000");
  // 3 × $33.33 @ 7.5%: per line round(3333×0.075)=round(249.975)=250 → 750.
  // (Taxing the summed base would give round(9999×0.075)=750 here, but e.g.
  // 2 lines of $0.10 @ 5% gives per-line 2×round(0.5)=2 vs total round(1)=1
  // — the invariant we guarantee is per-line-then-sum.)
  const inv = storage.createInvoice(orgId, userId, { customerId, date: "2026-01-05", dueDate: "2026-02-05",
    lines: [
      { description: "a", quantity: 1, rate: 3333, accountId: sales, taxRate: 7.5 },
      { description: "b", quantity: 1, rate: 3333, accountId: sales, taxRate: 7.5 },
      { description: "c", quantity: 1, rate: 3333, accountId: sales, taxRate: 7.5 },
    ] });
  assert.equal(inv.subtotal, 9999);
  assert.equal(inv.tax, 750);
  assert.equal(inv.total, 10749);
  // half-cent boundary: $0.10 @ 5% → 0.5¢ → rounds up to 1¢ per line
  const inv2 = storage.createInvoice(orgId, userId, { customerId, date: "2026-01-06", dueDate: "2026-02-06",
    lines: [
      { description: "tiny1", quantity: 1, rate: 10, accountId: sales, taxRate: 5 },
      { description: "tiny2", quantity: 1, rate: 10, accountId: sales, taxRate: 5 },
    ] });
  assert.equal(inv2.tax, 2);
  // GL ties: tax payable credited exactly invoice.tax
  const taxBal = -glBalance(orgId, "2100");
  assert.equal(taxBal, 750 + 2);
  // mixed rates per line
  const inv3 = storage.createInvoice(orgId, userId, { customerId, date: "2026-01-07", dueDate: "2026-02-07",
    lines: [
      { description: "taxed", quantity: 1, rate: 10000, accountId: sales, taxRate: 8.25 },
      { description: "exempt", quantity: 1, rate: 5000, accountId: sales, taxRate: 0 },
    ] });
  assert.equal(inv3.tax, Math.round(10000 * 0.0825));
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});
