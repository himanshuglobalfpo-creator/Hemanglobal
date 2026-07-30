// E2E — Settings data importers: CSV dry-run preview → commit.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet } from "./helpers";

test("importers: dry-run preview then commit customers", async ({ page }) => {
  await signup(page, uniqueUser("imp"));
  const request = page.request;

  await page.goto("/#/settings");
  await page.reload();
  await expect(page.getByTestId("card-data-import")).toBeVisible({ timeout: 15_000 });

  // Customers is the default importer; load the sample CSV and preview it.
  await page.getByTestId("button-import-sample").click();
  await page.getByTestId("button-import-preview").click();
  await expect(page.getByTestId("panel-import-preview")).toContainText("1 to insert", { timeout: 10_000 });

  // Commit — the customer is created.
  await page.getByTestId("button-import-commit").click();
  await expect.poll(async () => {
    const custs = await apiGet(request, "/api/customers");
    const rows = Array.isArray(custs) ? custs : custs.rows;
    return rows.some((c: any) => c.name === "Acme Co");
  }, { timeout: 15_000 }).toBeTruthy();
});
