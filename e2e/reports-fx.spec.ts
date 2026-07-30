// E2E — new Reports tabs + FX rate editor + FX revaluation.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("reports tabs + FX rates + revaluation", async ({ page, context }) => {
  await signup(page, uniqueUser("rpt"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const revenue = accounts.find((a) => a.code === "4000")!;
  const customer = await apiPost(context, request, "/api/customers", { name: "Report Client" });
  await apiPost(context, request, "/api/invoices", {
    customerId: customer.id, date: "2026-07-01", dueDate: "2026-07-31", taxRate: 0,
    lines: [{ description: "Work", quantity: 1, rate: 500, incomeAccountId: revenue.id }],
  });

  // --- New report tabs render real data ---
  await page.goto("/#/reports");
  await page.reload();
  await page.getByTestId("tab-sbc").click();
  await expect(page.getByTestId(`row-sbc-${customer.id}`)).toContainText("Report Client", { timeout: 15_000 });

  await page.getByTestId("tab-ebv").click();
  await expect(page.getByText(/No expenses in this range|Vendor/i).first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("tab-plm").click();
  await expect(page.getByTestId("table-plm")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("tab-1099").click();
  await expect(page.getByTestId("input-1099-year")).toBeVisible({ timeout: 10_000 });

  // --- FX rate editor in Settings ---
  await page.goto("/#/settings");
  await page.reload();
  await expect(page.getByTestId("card-fx-rates")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("input-fx-from").fill("EUR");
  await page.getByTestId("input-fx-to").fill("USD");
  await page.getByTestId("input-fx-rate").fill("1.1");
  await page.getByTestId("button-save-fx-rate").click();
  await expect.poll(async () => (await apiGet(request, "/api/settings/fx-rates")).length, { timeout: 10_000 }).toBeGreaterThan(0);

  // --- FX revaluation action in Period Close renders and runs (no open FX
  //     balances → posts a zero/no-op adjustment without error) ---
  await page.goto("/#/period-close");
  await page.reload();
  await expect(page.getByTestId("card-fx-revaluation")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("button-fx-revalue").click();
  // The action completes (a revaluation record is created) without throwing.
  await expect.poll(async () => {
    const revs = await apiGet(request, "/api/fx/revaluations");
    return (Array.isArray(revs) ? revs : revs.rows ?? []).length;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
});
