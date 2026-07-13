// E2E — FIFO costing surfaced in the Inventory report against the live server.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("FIFO inventory: buy two lots, sell, and see method + valuation in the Inventory report", async ({ page, context }) => {
  await signup(page, uniqueUser("inv"));
  const request = page.request;

  const me = await apiGet(request, "/api/auth/me");
  // Choose FIFO before any inventory has moved (org update is a PATCH).
  const csrf = (await context.cookies()).find((c) => c.name === "ll_csrf")?.value || "";
  const patch = await request.patch(`/api/orgs/${me.org.id}`, {
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    data: { costingMethod: "fifo" },
  });
  expect(patch.ok(), `PATCH org → ${patch.status()}`).toBeTruthy();

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const sales = accounts.find((a) => a.code === "4000")!;
  const cogs = accounts.find((a) => a.code === "5000")!;
  const inv = accounts.find((a) => a.code === "1200")!;

  const item = await apiPost(context, request, "/api/items", {
    sku: "WIDGET", name: "Widget", type: "inventory",
    salesAccountId: sales.id, expenseAccountId: cogs.id, cogsAccountId: cogs.id, inventoryAssetAccountId: inv.id,
  });
  const vendor = await apiPost(context, request, "/api/vendors", { name: "Supplier" });
  const customer = await apiPost(context, request, "/api/customers", { name: "Buyer" });

  // Buy 10 @ $2 then 10 @ $3.
  await apiPost(context, request, "/api/bills", { vendorId: vendor.id, date: "2026-01-01", dueDate: "2026-01-31", taxRate: 0, lines: [{ description: "Lot 1", quantity: 10, rate: 2, itemId: item.id }] });
  await apiPost(context, request, "/api/bills", { vendorId: vendor.id, date: "2026-02-01", dueDate: "2026-02-28", taxRate: 0, lines: [{ description: "Lot 2", quantity: 10, rate: 3, itemId: item.id }] });
  // Sell 15 → FIFO leaves 5 @ $3 = $15.
  await apiPost(context, request, "/api/invoices", { customerId: customer.id, date: "2026-03-01", dueDate: "2026-03-31", taxRate: 0, lines: [{ description: "Sale", quantity: 15, rate: 10, itemId: item.id }] });

  const val = await apiGet(request, "/api/reports/inventory-valuation");
  expect(val.costingMethod).toBe("fifo");
  expect(val.totalValuationCents).toBe(1_500);

  // Inventory report tab: method badge, item row, total, and layer breakdown.
  await page.goto("/#/reports");
  await page.reload();
  await page.getByTestId("tab-inv").click();
  await expect(page.getByTestId("badge-costing-method")).toContainText("FIFO", { timeout: 15_000 });
  await expect(page.getByTestId(`row-inv-item-${item.id}`)).toContainText("WIDGET");
  await expect(page.getByTestId("text-inv-total")).toContainText("$15.00");
  // Expand the FIFO cost layers for the item.
  await page.getByTestId(`button-layers-${item.id}`).click();
  await expect(page.getByText(/Qty left/i)).toBeVisible();
});
