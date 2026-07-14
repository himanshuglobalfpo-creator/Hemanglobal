// E2E — Payroll: add employee → create pay run → post → view stub.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("payroll: employee → pay run → post → stub", async ({ page, context }) => {
  await signup(page, uniqueUser("pay"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string; subtype: string }> = await apiGet(request, "/api/accounts");
  const bank = accounts.find((a) => a.subtype === "bank")!;

  // Salaried employee.
  const emp = await apiPost(context, request, "/api/payroll/employees", {
    name: "Jamie Payee", email: "jamie@pay.test", payType: "salary",
    payRateCents: 5_200_000, payFrequency: "biweekly", federalWithholdingRate: 0.1, stateWithholdingRate: 0.05,
  });
  expect(emp.id).toBeGreaterThan(0);

  await page.goto("/#/payroll");
  await page.reload();
  await expect(page.getByTestId(`row-employee-${emp.id}`)).toBeVisible({ timeout: 15_000 });

  // Create a pay run from the UI.
  await page.getByTestId("tab-runs").click();
  await page.getByTestId("button-new-run").click();
  await page.getByTestId("input-run-paydate").fill("2026-07-15");
  await page.getByTestId("input-run-start").fill("2026-07-01");
  await page.getByTestId("input-run-end").fill("2026-07-14");
  await page.getByTestId("button-save-run").click();

  // A draft run now exists; post it from the UI.
  await expect.poll(async () => {
    const runs = await apiGet(request, "/api/payroll/runs");
    return (Array.isArray(runs) ? runs : runs.rows ?? []).length;
  }, { timeout: 15_000 }).toBe(1);
  const runs = await apiGet(request, "/api/payroll/runs");
  const run = (Array.isArray(runs) ? runs : runs.rows)[0];
  await page.getByTestId(`button-post-run-${run.id}`).click();
  await expect.poll(async () => {
    const rs = await apiGet(request, "/api/payroll/runs");
    const r = (Array.isArray(rs) ? rs : rs.rows).find((x: any) => x.id === run.id);
    return r?.status;
  }, { timeout: 15_000 }).toBe("posted");

  // View the pay stub — net pay is positive.
  await page.getByTestId(`button-stub-run-${run.id}`).click();
  await expect(page.getByTestId("panel-stub")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("text-stub-net")).not.toHaveText("$0.00");

  // Liabilities accrued and are remittable.
  const liabilities = await apiGet(request, "/api/payroll/liabilities");
  expect(liabilities.some((l: any) => l.balanceCents > 0)).toBeTruthy();
});
