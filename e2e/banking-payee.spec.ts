// E2E — payee/vendor tag on a categorized bank transaction against the live server.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("bank payee: categorize an imported transaction with a vendor payee", async ({ page, context }) => {
  await signup(page, uniqueUser("payee"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const bank = accounts.find((a) => a.code === "1000")!;
  const expense = accounts.find((a) => a.code === "6000")!;
  const vendor = await apiPost(context, request, "/api/vendors", { name: "Acme Utilities" });

  // Import one unmatched withdrawal ($80 out) via the CSV import path.
  const imp = await apiPost(context, request, "/api/bank-transactions/import", {
    bankAccountId: bank.id, source: "csv",
    transactions: [{ date: "2026-03-01", description: "ELECTRIC BILL", amount: -80 }],
  });
  expect(imp.inserted).toBe(1);

  const list = await apiGet(request, `/api/bank-transactions?bankAccountId=${bank.id}&limit=50`);
  const rows = Array.isArray(list) ? list : list.rows;
  const txn = rows.find((t: any) => t.description === "ELECTRIC BILL");
  expect(txn, "imported transaction present").toBeTruthy();

  // Categorize it to an expense account, tagging the vendor as payee.
  await apiPost(context, request, `/api/bank-transactions/${txn.id}/match`, {
    matchType: "categorize", categoryAccountId: expense.id, vendorId: vendor.id,
  });

  // The transaction now carries the vendor + a payee derived from the vendor name.
  const after = await apiGet(request, `/api/bank-transactions?bankAccountId=${bank.id}&limit=50`);
  const afterRows = Array.isArray(after) ? after : after.rows;
  const matched = afterRows.find((t: any) => t.id === txn.id);
  expect(matched.status).toBe("matched");
  expect(matched.vendorId).toBe(vendor.id);
  expect(matched.payee).toBe("Acme Utilities");

  // The Banking page mounts cleanly (the payee itself is verified via the live
  // API above; which tab renders a matched row is UI-state we don't pin here).
  await page.goto("/#/banking");
  await page.reload();
  await expect(page.getByTestId("text-page-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
});
