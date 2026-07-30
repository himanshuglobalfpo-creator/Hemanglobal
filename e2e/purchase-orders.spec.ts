// E2E — Purchase orders: create then receive (which posts a bill).
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("purchase orders: create → receive → bill posted", async ({ page, context }) => {
  await signup(page, uniqueUser("po"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const expense = accounts.find((a) => a.code === "6000")!;
  const vendor = await apiPost(context, request, "/api/vendors", { name: "PO Vendor" });

  const po = await apiPost(context, request, "/api/purchase-orders", {
    vendorId: vendor.id, date: "2026-07-01",
    lines: [{ description: "Widgets", quantity: 10, rate: 5, expenseAccountId: expense.id }],
  });
  expect(po.status).toBe("open");

  await page.goto("/#/purchase-orders");
  await page.reload();
  await expect(page.getByTestId(`row-po-${po.id}`)).toBeVisible({ timeout: 15_000 });

  // Receive all 10 units → a bill is created and the PO becomes fully received.
  await page.getByTestId(`button-receive-po-${po.id}`).click();
  const detail = await apiGet(request, `/api/purchase-orders/${po.id}`);
  const lineId = detail.lines[0].id;
  await expect(page.getByTestId(`input-receive-qty-${lineId}`)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`input-receive-qty-${lineId}`).fill("10");
  await page.getByTestId("button-confirm-receive").click();

  // A bill for $50 now exists for the vendor.
  await expect.poll(async () => {
    const bills = await apiGet(request, "/api/bills");
    const rows = Array.isArray(bills) ? bills : bills.rows;
    return rows.some((b: any) => b.vendorId === vendor.id && b.total === 5_000);
  }, { timeout: 15_000 }).toBeTruthy();

  // The PO is now fully received.
  await expect.poll(async () => (await apiGet(request, `/api/purchase-orders/${po.id}`)).status, { timeout: 10_000 }).toBe("received");
});
