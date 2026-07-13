// E2E — project (job) tracking + per-project P&L against the live server.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet, apiPost } from "./helpers";

test("project tracking: tag an invoice to a project and see it in P&L by Project", async ({ page, context }) => {
  await signup(page, uniqueUser("proj"));
  const request = page.request;

  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const revenue = accounts.find((a) => a.code === "4000")!;

  const customer = await apiPost(context, request, "/api/customers", { name: "Job Client" });
  const project = await apiPost(context, request, "/api/projects", { name: "Kitchen Remodel", customerId: customer.id });
  expect(project.id).toBeGreaterThan(0);
  expect(project.customerId).toBe(customer.id);

  // Invoice with a project-tagged revenue line.
  const invoice = await apiPost(context, request, "/api/invoices", {
    customerId: customer.id, date: "2026-07-10", dueDate: "2026-08-10", taxRate: 0,
    lines: [{ description: "Cabinets", quantity: 1, rate: 400, incomeAccountId: revenue.id, projectId: project.id }],
  });
  expect(invoice.total).toBe(40_000);

  // Per-project P&L rolls the income up under the project.
  const ppl = await apiGet(request, "/api/reports/project-pl?from=2026-01-01&to=2026-12-31");
  const row = ppl.rows.find((r: any) => r.projectId === project.id);
  expect(row, "project appears in P&L by Project").toBeTruthy();
  expect(row.income).toBe(40_000);
  expect(row.net).toBe(40_000);

  // The "P&L by Project" report tab renders the project row in the UI.
  await page.goto("/#/reports");
  await page.reload();
  await page.getByTestId("tab-ppl").click();
  await expect(page.getByTestId(`row-project-${project.id}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`row-project-${project.id}`)).toContainText("Kitchen Remodel");
});
