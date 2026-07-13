// E2E — the global "+ Create" menu opens the right create flow (QBO-style).
import { test, expect } from "@playwright/test";
import { uniqueUser, signup } from "./helpers";

test("create menu: opens grouped shortcuts that land in the right create dialog", async ({ page }) => {
  await signup(page, uniqueUser("create"));

  // The Create button lives in the top bar and opens a grouped menu.
  await page.getByTestId("button-create").click();
  const menu = page.getByTestId("menu-create");
  await expect(menu).toBeVisible();
  // Grouped headings + a representative item from each column.
  await expect(menu.getByText("Customers", { exact: true })).toBeVisible();
  await expect(menu.getByText("Vendors", { exact: true })).toBeVisible();
  await expect(menu.getByText("Other", { exact: true })).toBeVisible();
  await expect(page.getByTestId("link-create-invoice")).toBeVisible();
  await expect(page.getByTestId("link-create-bill")).toBeVisible();
  await expect(page.getByTestId("link-create-journal")).toBeVisible();

  // Invoice → invoices page with the create dialog already open.
  await page.getByTestId("link-create-invoice").click();
  await expect(page.getByTestId("button-save-invoice")).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toContain("#/invoices");
  // Close and confirm the menu really routed us to Invoices.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("text-page-title")).toHaveText("Invoices");

  // Add customer → customers page with its dialog open (different column).
  await page.getByTestId("button-create").click();
  await page.getByTestId("link-create-customer").click();
  await expect(page.getByTestId("input-customer-name")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape"); // close the modal before reopening the menu

  // Journal entry → journal page with the manual-entry dialog open.
  await page.getByTestId("button-create").click();
  await page.getByTestId("link-create-journal").click();
  await expect(page.getByTestId("text-page-title")).toHaveText("General Journal", { timeout: 15_000 });
  await expect(page.getByTestId("input-journal-memo")).toBeVisible();
});
