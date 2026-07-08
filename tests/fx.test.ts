/**
 * TASK 1 acceptance tests — realized FX gain/loss math.
 * EUR invoice at 1.10 for €100 books $110 to A/R; payment of €100 at 1.08
 * books $108 to bank and $2 to FX Loss; trial balance stays balanced;
 * USD-only orgs are untouched by the FX columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestOrg, createCustomer, createVendor, accountId, glBalance, storage, db } from "./setup.js";

test("EUR invoice @1.10 books base $110 to A/R; €100 payment @1.08 posts $2 FX loss", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "Euro Client", "EUR");
  const sales = accountId(orgId, "4000");

  const invoice = storage.createInvoice(orgId, userId, {
    customerId,
    date: "2026-01-15",
    dueDate: "2026-02-15",
    currency: "EUR",
    fxRate: 1.1,
    lines: [{ description: "Consulting", quantity: 1, rate: 10000, accountId: sales, taxRate: 0 }],
  });

  assert.equal(invoice.currency, "EUR");
  assert.equal(invoice.foreign_total, 10000); // €100.00
  assert.equal(invoice.total, 11000); // $110.00 base
  assert.equal(glBalance(orgId, "1100"), 11000); // A/R carries $110
  assert.equal(glBalance(orgId, "4000"), -11000); // Sales credited $110

  const paid = storage.payInvoice(orgId, userId, invoice.id, {
    date: "2026-02-01",
    bankAccountId: accountId(orgId, "1000"),
    foreignAmount: 10000, // €100.00
    fxRate: 1.08,
  });

  assert.equal(paid.status, "paid");
  assert.equal(glBalance(orgId, "1000"), 10800); // bank received $108
  assert.equal(glBalance(orgId, "1100"), 0); // A/R fully relieved
  assert.equal(glBalance(orgId, "6950"), 200); // FX Loss $2.00
  assert.equal(glBalance(orgId, "4950"), 0);

  // Trial balance must balance.
  const tb = storage.trialBalance(orgId);
  const dr = tb.reduce((s, r) => s + r.debit, 0);
  const cr = tb.reduce((s, r) => s + r.credit, 0);
  assert.equal(dr, cr);
});

test("payment at a HIGHER rate posts FX gain", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "Gainer", "EUR");
  const invoice = storage.createInvoice(orgId, userId, {
    customerId,
    date: "2026-01-15",
    dueDate: "2026-02-15",
    currency: "EUR",
    fxRate: 1.1,
    lines: [{ description: "Work", quantity: 1, rate: 10000, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  storage.payInvoice(orgId, userId, invoice.id, {
    date: "2026-02-01",
    bankAccountId: accountId(orgId, "1000"),
    foreignAmount: 10000,
    fxRate: 1.12,
  });
  assert.equal(glBalance(orgId, "1000"), 11200);
  assert.equal(glBalance(orgId, "4950"), -200); // FX Gain credited $2
  assert.equal(glBalance(orgId, "6950"), 0);
});

test("FX bill: pay €100 bill (booked @1.10) at 1.08 → FX GAIN of $2", () => {
  const { orgId, userId } = createTestOrg("USD");
  const vendorId = createVendor(orgId, "Euro Vendor", "EUR");
  const bill = storage.createBill(orgId, userId, {
    vendorId,
    date: "2026-01-10",
    dueDate: "2026-02-10",
    currency: "EUR",
    fxRate: 1.1,
    lines: [{ description: "Hosting", quantity: 1, rate: 10000, accountId: accountId(orgId, "6000"), taxRate: 0 }],
  });
  assert.equal(bill.total, 11000);
  storage.payBill(orgId, userId, bill.id, {
    date: "2026-02-05",
    bankAccountId: accountId(orgId, "1000"),
    foreignAmount: 10000,
    fxRate: 1.08,
  });
  assert.equal(glBalance(orgId, "2000"), 0); // A/P relieved in full
  assert.equal(glBalance(orgId, "1000"), -10800); // cash out $108
  assert.equal(glBalance(orgId, "4950"), -200); // settled liability cheaper → gain
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});

test("per-line rounding: base cents are rounded per line THEN summed", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "Rounding Co", "EUR");
  const sales = accountId(orgId, "4000");
  // Two lines of €0.15 at rate 1.11: per-line round(15*1.11)=17 → total 34.
  // (Summing first would give round(30*1.11)=33 — the wrong discipline.)
  const invoice = storage.createInvoice(orgId, userId, {
    customerId,
    date: "2026-03-01",
    dueDate: "2026-03-31",
    currency: "EUR",
    fxRate: 1.11,
    lines: [
      { description: "A", quantity: 1, rate: 15, accountId: sales, taxRate: 0 },
      { description: "B", quantity: 1, rate: 15, accountId: sales, taxRate: 0 },
    ],
  });
  assert.equal(invoice.foreign_total, 30);
  assert.equal(invoice.total, 34);
});

test("fxRate is required for foreign documents and must be > 0", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "NoRate", "EUR");
  assert.throws(
    () =>
      storage.createInvoice(orgId, userId, {
        customerId,
        date: "2026-01-01",
        dueDate: "2026-01-31",
        currency: "EUR",
        lines: [{ description: "x", quantity: 1, rate: 100, accountId: accountId(orgId, "4000"), taxRate: 0 }],
      }),
    /fxRate required/i,
  );
});

test("USD-only org: base reports and columns unchanged (currency sentinel '')", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "Domestic");
  const invoice = storage.createInvoice(orgId, userId, {
    customerId,
    date: "2026-01-15",
    dueDate: "2026-02-15",
    lines: [{ description: "Widget", quantity: 2, rate: 2500, accountId: accountId(orgId, "4000"), taxRate: 10 }],
  });
  assert.equal(invoice.currency, "");
  assert.equal(invoice.fx_rate, 1);
  assert.equal(invoice.foreign_total, 0); // FX columns untouched for base docs
  assert.equal(invoice.subtotal, 5000);
  assert.equal(invoice.tax, 500);
  assert.equal(invoice.total, 5500);
  storage.payInvoice(orgId, userId, invoice.id, { date: "2026-02-01", amount: 5500, bankAccountId: accountId(orgId, "1000") });
  assert.equal(glBalance(orgId, "1100"), 0);
  assert.equal(glBalance(orgId, "4950"), 0);
  assert.equal(glBalance(orgId, "6950"), 0);
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});

test("partial foreign payments never strand a rounding cent in A/R", () => {
  const { orgId, userId } = createTestOrg("USD");
  const customerId = createCustomer(orgId, "Partial Payer", "EUR");
  const invoice = storage.createInvoice(orgId, userId, {
    customerId,
    date: "2026-01-15",
    dueDate: "2026-02-15",
    currency: "EUR",
    fxRate: 1.115, // awkward rate on purpose
    lines: [{ description: "svc", quantity: 1, rate: 9999, accountId: accountId(orgId, "4000"), taxRate: 0 }],
  });
  storage.payInvoice(orgId, userId, invoice.id, { date: "2026-02-01", bankAccountId: accountId(orgId, "1000"), foreignAmount: 3333, fxRate: 1.1 });
  storage.payInvoice(orgId, userId, invoice.id, { date: "2026-02-10", bankAccountId: accountId(orgId, "1000"), foreignAmount: 3333, fxRate: 1.12 });
  const final = storage.payInvoice(orgId, userId, invoice.id, { date: "2026-02-20", bankAccountId: accountId(orgId, "1000"), foreignAmount: 3333, fxRate: 1.09 });
  assert.equal(final.status, "paid");
  assert.equal(glBalance(orgId, "1100"), 0); // no 1¢ residue
  const tb = storage.trialBalance(orgId);
  assert.equal(tb.reduce((s, r) => s + r.debit, 0), tb.reduce((s, r) => s + r.credit, 0));
});

test("fx_rates table upsert + lookup on/before date", () => {
  const { orgId } = createTestOrg("USD");
  storage.upsertFxRate(orgId, "2026-01-01", "EUR", "USD", 1.05);
  storage.upsertFxRate(orgId, "2026-01-10", "EUR", "USD", 1.1);
  storage.upsertFxRate(orgId, "2026-01-10", "EUR", "USD", 1.11); // upsert same key
  assert.equal(storage.lookupFxRate(orgId, "2026-01-05", "EUR", "USD"), 1.05);
  assert.equal(storage.lookupFxRate(orgId, "2026-01-15", "EUR", "USD"), 1.11);
  assert.equal(storage.lookupFxRate(orgId, "2025-12-31", "EUR", "USD"), undefined);
  // Org isolation: a different org sees nothing.
  const other = createTestOrg("USD");
  assert.equal(storage.lookupFxRate(other.orgId, "2026-01-15", "EUR", "USD"), undefined);
  void db;
});
