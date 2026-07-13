// E2E — Advanced transactions search page + global-search dropdown link.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("advanced transactions search: unified results, filtering, and the dropdown link", async ({ page, context }) => {
  await signup(page, uniqueUser("txnsearch"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const bank = accounts.find((a) => a.code === "1000")!;
  const revenue = accounts.find((a) => a.code === "4000")!;

  const customer = await apiPost(context, request, "/api/customers", { name: "Globex Inc" });
  const invoice = await apiPost(context, request, "/api/invoices", {
    customerId: customer.id, date: "2026-05-01", dueDate: "2026-05-31", taxRate: 0,
    lines: [{ description: "Consulting", quantity: 1, rate: 500, incomeAccountId: revenue.id }],
  });
  await apiPost(context, request, "/api/bank-transactions/import", {
    bankAccountId: bank.id, source: "csv",
    transactions: [{ date: "2026-05-03", description: "UBER EATS", amount: -80 }],
  });

  // The unified search endpoint returns both the invoice and the bank expense.
  const res = await apiGet(request, "/api/transactions/search?limit=100");
  expect(res.total).toBeGreaterThanOrEqual(2);
  expect(res.rows.some((r: any) => r.type === "invoice")).toBeTruthy();
  expect(res.rows.some((r: any) => r.type === "expense")).toBeTruthy();

  // ---- The page renders results and filters by reference number ----
  await page.goto("/#/transactions");
  await page.reload();
  await expect(page.getByTestId("text-page-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`row-txn-invoice-${invoice.id}`)).toBeVisible();

  // Filter by the invoice's reference number → the bank expense drops out.
  await page.getByTestId("input-reference").fill(invoice.number);
  await expect(page.getByTestId(`row-txn-invoice-${invoice.id}`)).toBeVisible();
  await expect(page.locator('[data-testid^="row-txn-expense-"]')).toHaveCount(0);

  // ---- The global search dropdown offers the Advanced search link ----
  await page.getByTestId("button-open-search").click();
  await expect(page.getByTestId("input-global-search")).toBeVisible();
  await page.getByTestId("link-advanced-search").click();
  await expect.poll(() => page.url()).toContain("/transactions");
});
