// E2E — Fixed assets: register, post depreciation, dispose.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("fixed assets: register → depreciate → dispose", async ({ page, context }) => {
  await signup(page, uniqueUser("fa"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string; type: string; subtype: string }> = await apiGet(request, "/api/accounts");
  const assetAcct = accounts.find((a) => a.type === "asset")!;
  const depExpense = accounts.find((a) => a.type === "expense")!;
  const income = accounts.find((a) => a.type === "income")!;

  // Register a $12,000 asset, straight line over 12 months → $1,000/mo.
  const asset = await apiPost(context, request, "/api/fixed-assets", {
    name: "Company Van", acquisitionDate: "2026-01-15",
    costCents: 1_200_000, salvageCents: 0, usefulLifeMonths: 12, method: "straight_line",
    assetAccountId: assetAcct.id, accumDepAccountId: assetAcct.id, depreciationExpenseAccountId: depExpense.id,
  });
  expect(asset.status).toBe("active");

  await page.goto("/#/fixed-assets");
  await page.reload();
  await expect(page.getByTestId(`row-asset-${asset.id}`)).toBeVisible({ timeout: 15_000 });

  // Post depreciation for a period after acquisition.
  await page.getByTestId("input-dep-period").fill("2026-02");
  await page.getByTestId(`button-depreciate-asset-${asset.id}`).click();
  await expect.poll(async () => {
    const je = await apiGet(request, "/api/journal");
    const rows = Array.isArray(je) ? je : je.rows ?? [];
    return rows.some((e: any) => (e.memo || "").toLowerCase().includes("depreciation"));
  }, { timeout: 15_000 }).toBeTruthy();

  // Dispose the asset for $500 gain/loss to an income account (scrap = 0 proceeds).
  await page.getByTestId(`button-dispose-asset-${asset.id}`).click();
  await expect(page.getByTestId("select-dispose-gainloss-account")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("select-dispose-gainloss-account").click();
  await page.getByRole("option", { name: new RegExp(String(income.code)) }).first().click();
  await page.getByTestId("button-confirm-dispose").click();

  await expect.poll(async () => (await apiGet(request, `/api/fixed-assets/${asset.id}`)).status, { timeout: 15_000 }).toBe("disposed");
});
