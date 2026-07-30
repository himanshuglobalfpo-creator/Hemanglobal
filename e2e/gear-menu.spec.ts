// E2E — the QBO-style gear (settings) menu + the pages it unlocks:
// Products and services (/items) and Budgeting (/budgets).
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet } from "./helpers";

test("gear menu: grouped shortcuts reach Products & Services and Budgeting", async ({ page, context }) => {
  await signup(page, uniqueUser("gear"));
  const request = page.request;

  // Gear opens a grouped menu with all four QBO-style columns.
  await page.getByTestId("button-gear").click();
  const menu = page.getByTestId("menu-gear");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Your Company", { exact: true })).toBeVisible();
  await expect(menu.getByText("Lists", { exact: true })).toBeVisible();
  await expect(menu.getByText("Tools", { exact: true })).toBeVisible();
  await expect(menu.getByText("Profile", { exact: true })).toBeVisible();
  await expect(page.getByTestId("link-gear-settings")).toBeVisible();
  await expect(page.getByTestId("link-gear-signout")).toBeVisible();

  // Lists → Products and services.
  await page.getByTestId("link-gear-items").click();
  await expect(page.getByTestId("text-page-title")).toHaveText("Products and services", { timeout: 15_000 });

  // Create a service item through the UI.
  const accounts: Array<{ id: number; code: string; name: string }> = await apiGet(request, "/api/accounts");
  await page.getByTestId("button-new-item").click();
  await page.getByTestId("input-item-sku").fill("CONSULT");
  await page.getByTestId("input-item-name").fill("Consulting");
  await expect(page.getByTestId("button-save-item")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("button-save-item").click();
  // It is really persisted; the new row appears in the table.
  await expect.poll(async () => {
    const items = await apiGet(request, "/api/items?limit=50");
    const rows = Array.isArray(items) ? items : items.rows;
    return rows.some((i: any) => i.sku === "CONSULT");
  }, { timeout: 15_000 }).toBeTruthy();
  const created = await apiGet(request, "/api/items?limit=50");
  const createdRows = Array.isArray(created) ? created : created.rows;
  const newItem = createdRows.find((i: any) => i.sku === "CONSULT");
  await expect(page.getByTestId(`row-item-${newItem.id}`)).toContainText("Consulting");

  // Tools → Budgeting.
  await page.getByTestId("button-gear").click();
  await page.getByTestId("link-gear-budgeting").click();
  await expect(page.getByTestId("text-page-title")).toHaveText("Budgeting", { timeout: 15_000 });

  // Create a budget, set one account's monthly amount, and see budget-vs-actual.
  await page.getByTestId("button-new-budget").click();
  await page.getByTestId("input-budget-name").fill("Ops Budget");
  await page.getByTestId("input-budget-year").fill("2026");
  await page.getByTestId("button-create-budget").click();

  const income = accounts.find((a) => a.code === "4000")!;
  await expect(page.getByTestId(`input-budget-amount-${income.id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`input-budget-amount-${income.id}`).fill("1000");
  await page.getByTestId("button-save-budget").click();

  // The budget-vs-actual row for that account shows the annual budget (12 × $1,000).
  await expect(page.getByTestId(`row-bva-${income.id}`)).toContainText("$12,000.00", { timeout: 15_000 });

  // Budget persisted server-side with 12 monthly lines for the account.
  const budgets = await apiGet(request, "/api/budgets");
  expect(budgets.length).toBe(1);
  const detail = await apiGet(request, `/api/budgets/${budgets[0].id}`);
  expect(detail.lines.filter((l: any) => l.accountId === income.id).length).toBe(12);
});
