// E2E — invoice/bill void + share-link management on the existing pages.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("invoice actions: manage share links + void; bill void", async ({ page, context }) => {
  await signup(page, uniqueUser("invact"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const revenue = accounts.find((a) => a.code === "4000")!;
  const expense = accounts.find((a) => a.code === "6000")!;
  const customer = await apiPost(context, request, "/api/customers", { name: "Act Client" });
  const vendor = await apiPost(context, request, "/api/vendors", { name: "Act Vendor" });

  const invoice = await apiPost(context, request, "/api/invoices", {
    customerId: customer.id, date: "2026-07-01", dueDate: "2026-07-31", taxRate: 0,
    lines: [{ description: "Work", quantity: 1, rate: 200, incomeAccountId: revenue.id }],
  });
  const bill = await apiPost(context, request, "/api/bills", {
    vendorId: vendor.id, date: "2026-07-01", dueDate: "2026-07-31", taxRate: 0,
    lines: [{ description: "Supplies", quantity: 1, rate: 50, expenseAccountId: expense.id }],
  });

  // --- Share management on the Invoices page ---
  await page.goto("/#/invoices");
  await page.reload();
  await expect(page.getByTestId(`row-invoice-${invoice.id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`button-shares-invoice-${invoice.id}`).click();
  await page.getByTestId("button-create-share").click();
  // A share now exists server-side; revoke it from the UI.
  await expect.poll(async () => (await apiGet(request, `/api/invoices/${invoice.id}/shares`)).length, { timeout: 10_000 }).toBe(1);
  const shares = await apiGet(request, `/api/invoices/${invoice.id}/shares`);
  await page.getByTestId(`button-revoke-share-${shares[0].id}`).click();
  await expect.poll(async () => (await apiGet(request, `/api/invoices/${invoice.id}/shares`))[0].revokedAt, { timeout: 10_000 }).toBeTruthy();
  await page.getByTestId("button-close-shares").click();
  await expect(page.getByTestId("button-create-share")).toBeHidden(); // wait for the dialog overlay to detach

  // --- Void the invoice ---
  page.once("dialog", (d) => d.accept());
  await page.getByTestId(`button-void-invoice-${invoice.id}`).click();
  await expect.poll(async () => {
    const invs = await apiGet(request, "/api/invoices");
    const rows = Array.isArray(invs) ? invs : invs.rows;
    return rows.find((i: any) => i.id === invoice.id)?.status;
  }, { timeout: 15_000 }).toBe("void");

  // --- Void the bill on the Bills page ---
  await page.goto("/#/bills");
  await page.reload();
  await expect(page.getByTestId(`row-bill-${bill.id}`)).toBeVisible({ timeout: 15_000 });
  page.once("dialog", (d) => d.accept());
  await page.getByTestId(`button-void-bill-${bill.id}`).click();
  await expect.poll(async () => {
    const bills = await apiGet(request, "/api/bills");
    const rows = Array.isArray(bills) ? bills : bills.rows;
    return rows.find((b: any) => b.id === bill.id)?.status;
  }, { timeout: 15_000 }).toBe("void");
});
