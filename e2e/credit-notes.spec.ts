// E2E — Credit notes: create, apply to an open invoice, verify balances.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("credit notes: create → apply to invoice → credit consumed", async ({ page, context }) => {
  await signup(page, uniqueUser("cn"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const revenue = accounts.find((a) => a.code === "4000")!;
  const customer = await apiPost(context, request, "/api/customers", { name: "Credit Client" });

  // An open $300 invoice for the customer.
  const invoice = await apiPost(context, request, "/api/invoices", {
    customerId: customer.id, date: "2026-07-01", dueDate: "2026-07-31", taxRate: 0,
    lines: [{ description: "Work", quantity: 1, rate: 300, incomeAccountId: revenue.id }],
  });
  expect(invoice.total).toBe(30_000);

  // A $100 credit note.
  const note = await apiPost(context, request, "/api/credit-notes", {
    customerId: customer.id, date: "2026-07-02", reason: "Partial refund", taxRate: 0,
    lines: [{ description: "Adjustment", quantity: 1, rate: 100, revenueAccountId: revenue.id }],
  });
  expect(note.total).toBe(10_000);

  // Customer starts with $100 of available credit.
  await expect.poll(async () => (await apiGet(request, `/api/customers/${customer.id}/credit-balance`)).creditBalance, { timeout: 10_000 }).toBe(10_000);

  // Open the page, apply the credit to the invoice via the UI.
  await page.goto("/#/credit-notes");
  await page.reload();
  await expect(page.getByTestId(`row-credit-note-${note.id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`button-manage-credit-note-${note.id}`).click();
  await expect(page.getByTestId("select-apply-invoice")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("input-apply-amount").fill("100");
  await page.getByTestId("button-apply-credit").click();

  // Invoice balance drops by $100; the note's remaining credit is exhausted.
  await expect.poll(async () => {
    const invs = await apiGet(request, "/api/invoices");
    const rows = Array.isArray(invs) ? invs : invs.rows;
    const inv = rows.find((i: any) => i.id === invoice.id);
    return inv.total - inv.amountPaid;
  }, { timeout: 15_000 }).toBe(20_000);
  await expect.poll(async () => (await apiGet(request, `/api/credit-notes/${note.id}`)).remainingCredit, { timeout: 10_000 }).toBe(0);
});
