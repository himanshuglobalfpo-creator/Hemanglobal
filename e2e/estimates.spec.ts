// E2E — Estimates: create, convert to invoice, share link.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("estimates: create → convert to invoice → share", async ({ page, context }) => {
  await signup(page, uniqueUser("est"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const revenue = accounts.find((a) => a.code === "4000")!;
  const customer = await apiPost(context, request, "/api/customers", { name: "Quote Client", email: "q@client.test" });

  // Create an estimate via the API (line editor is covered by the invoice specs).
  const est = await apiPost(context, request, "/api/estimates", {
    customerId: customer.id, date: "2026-07-01", expiryDate: "2026-07-31", taxRate: 0,
    lines: [{ description: "Design work", quantity: 2, rate: 500, incomeAccountId: revenue.id }],
  });
  expect(est.totalCents).toBe(100_000);

  // The Estimates page lists it.
  await page.goto("/#/estimates");
  await page.reload();
  await expect(page.getByTestId(`row-estimate-${est.id}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`row-estimate-${est.id}`)).toContainText("Quote Client");

  // Convert to invoice from the UI.
  await page.getByTestId(`button-convert-estimate-${est.id}`).click();
  await expect.poll(async () => {
    const invs = await apiGet(request, "/api/invoices");
    const rows = Array.isArray(invs) ? invs : invs.rows;
    return rows.some((i: any) => i.estimateId === est.id && i.total === 100_000);
  }, { timeout: 15_000 }).toBeTruthy();

  // The estimate flips to "invoiced".
  await expect.poll(async () => (await apiGet(request, `/api/estimates/${est.id}`)).status, { timeout: 15_000 }).toBe("invoiced");

  // Share produces a public link.
  await page.getByTestId(`button-share-estimate-${est.id}`).click();
  await expect(page.getByTestId("input-estimate-share-url")).toHaveValue(/\/p\/estimate\//, { timeout: 15_000 });
});
