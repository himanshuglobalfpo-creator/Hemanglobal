// E2E — rebuilt Banking page: account cards, three tabs, category, Undo.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("banking tabs: import 3, categorize + exclude, see tabs/category, Undo back to review", async ({ page, context }) => {
  await signup(page, uniqueUser("banktabs"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string; name: string }> = await apiGet(request, "/api/accounts");
  const bank = accounts.find((a) => a.code === "1000")!;
  const expense = accounts.find((a) => a.code === "6000")!;

  // Import three withdrawals — all land in For Review.
  const imp = await apiPost(context, request, "/api/bank-transactions/import", {
    bankAccountId: bank.id, source: "csv",
    transactions: [
      { date: "2026-06-01", description: "OFFICE SUPPLIES", amount: -80 },
      { date: "2026-06-02", description: "SOFTWARE SUB", amount: -50 },
      { date: "2026-06-03", description: "BANK FEE", amount: -30 },
    ],
  });
  expect(imp.inserted).toBe(3);

  const list = await apiGet(request, `/api/bank-transactions?bankAccountId=${bank.id}&limit=50`);
  const rows = Array.isArray(list) ? list : list.rows;
  const supplies = rows.find((t: any) => t.description === "OFFICE SUPPLIES");
  const software = rows.find((t: any) => t.description === "SOFTWARE SUB");

  // Categorize one to the expense account, exclude another.
  await apiPost(context, request, `/api/bank-transactions/${supplies.id}/match`, { matchType: "categorize", categoryAccountId: expense.id });
  await apiPost(context, request, `/api/bank-transactions/${software.id}/match`, { matchType: "ignore" });

  // The account summary endpoint reports the ledger balance + review count.
  const sums = await apiGet(request, "/api/accounts/balances?subtype=bank");
  const s = sums.find((x: any) => x.accountId === bank.id);
  expect(s.reviewCount).toBe(1);
  expect(s.ledgerBalanceCents).toBe(-8000);

  // Trial balance is balanced after the postings.
  const tb1 = await apiGet(request, "/api/reports/trial-balance");
  expect(tb1.totalDebit).toBe(tb1.totalCredit);

  // ---- UI: the Banking page renders the account card + three tabs ----
  await page.goto("/#/banking");
  await page.reload();
  await expect(page.getByTestId("text-page-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`card-bank-${bank.id}`)).toBeVisible();
  await expect(page.getByTestId(`text-ledger-balance-${bank.id}`)).toBeVisible();

  // Categorized tab shows the category name.
  await page.getByTestId("tab-categorized").click();
  await expect(page.getByTestId(`text-category-${supplies.id}`)).toContainText(expense.name, { timeout: 10_000 });

  // Excluded tab shows the excluded row with an Undo button.
  await page.getByTestId("tab-excluded").click();
  await expect(page.getByTestId(`row-banktx-${software.id}`)).toBeVisible();

  // Undo the categorized row from the Categorized tab.
  await page.getByTestId("tab-categorized").click();
  await page.getByTestId(`button-undo-${supplies.id}`).click();

  // It returns to For Review (verified via API — the tab's live count is UI state).
  await expect(async () => {
    const after = await apiGet(request, `/api/bank-transactions?bankAccountId=${bank.id}&status=unmatched&limit=50`);
    const arr = Array.isArray(after) ? after : after.rows;
    expect(arr.some((t: any) => t.id === supplies.id)).toBeTruthy();
  }).toPass({ timeout: 10_000 });

  // Trial balance still balances after the undo.
  const tb2 = await apiGet(request, "/api/reports/trial-balance");
  expect(tb2.totalDebit).toBe(tb2.totalCredit);
});
