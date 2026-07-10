// ============================================================================
// E2E — critical flows against the LIVE production build (real DB, real server)
// ============================================================================
// Covers: signup, create invoice, take payment, reconcile (page), and view the
// Trial Balance. Signup and navigation are driven through the real UI; the
// transactional accounting flow (invoice → payment → trial balance) is driven
// against the running server's authenticated API using the session + CSRF
// cookies the UI signup established — that exercises the full stack (routes →
// storage → Postgres) exactly as production runs it, without depending on
// multi-step form internals.
// ============================================================================

import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";

const uniq = Date.now();
const USER = {
  name: "E2E Tester",
  org: `E2E Org ${uniq}`,
  email: `e2e-${uniq}@example.com`,
  password: "Ledger$ecure99", // ≥10 chars, 3+ char classes, no email local part
};

// Build the x-csrf-token header from the double-submit cookie the server set.
async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const cookies = await context.cookies();
  const csrf = cookies.find((c) => c.name === "ll_csrf")?.value;
  return csrf ? { "x-csrf-token": csrf, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function apiGet(request: APIRequestContext, url: string) {
  const res = await request.get(url);
  expect(res.ok(), `GET ${url} → ${res.status()}`).toBeTruthy();
  return res.json();
}

async function apiPost(context: BrowserContext, request: APIRequestContext, url: string, data: unknown) {
  const res = await request.post(url, { headers: await csrfHeaders(context), data });
  expect(res.ok(), `POST ${url} → ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
  return res.json();
}

test("signup → create invoice → take payment → trial balance → navigate critical pages", async ({ page, context }) => {
  // ---- 1. SIGNUP (real UI) ------------------------------------------------
  await page.goto("/");
  await page.getByTestId("link-to-signup").click();
  await page.getByTestId("input-signup-name").fill(USER.name);
  await page.getByTestId("input-signup-org").fill(USER.org);
  await page.getByTestId("input-signup-email").fill(USER.email);
  await page.getByTestId("input-signup-password").fill(USER.password);
  await page.getByTestId("checkbox-signup-terms").check();
  await page.getByTestId("button-signup").click();

  // Landing in the app shell (the persistent page-title chrome) confirms the
  // session was established and the SPA routed to the dashboard.
  await expect(page.getByTestId("text-page-title")).toBeVisible({ timeout: 15_000 });

  const request = page.request;

  // ---- 2. CREATE INVOICE (live API, authenticated) ------------------------
  const accounts: Array<{ id: number; code: string }> = await apiGet(request, "/api/accounts");
  const revenue = accounts.find((a) => a.code === "4000")!;
  const bank = accounts.find((a) => a.code === "1000")!;
  expect(revenue, "revenue account 4000 seeded").toBeTruthy();
  expect(bank, "bank account 1000 seeded").toBeTruthy();

  const customer = await apiPost(context, request, "/api/customers", { name: "E2E Customer" });
  expect(customer.id).toBeGreaterThan(0);

  const invoice = await apiPost(context, request, "/api/invoices", {
    customerId: customer.id,
    date: "2026-07-10",
    dueDate: "2026-08-10",
    taxRate: 0,
    lines: [{ description: "Consulting", quantity: 1, rate: 100, incomeAccountId: revenue.id }],
  });
  // Money is integer cents: a $100 invoice totals 10000.
  expect(invoice.total).toBe(10_000);

  // ---- 3. TRIAL BALANCE reflects the invoice, and balances ----------------
  const tbBefore = await apiGet(request, "/api/reports/trial-balance?asOf=2026-07-10");
  expect(tbBefore.totalDebit).toBe(tbBefore.totalCredit); // debits == credits, always
  expect(tbBefore.totalDebit).toBe(10_000); // Dr A/R 100 = Cr Revenue 100

  // ---- 4. TAKE PAYMENT (live API) -----------------------------------------
  await apiPost(context, request, `/api/invoices/${invoice.id}/pay`, {
    date: "2026-07-10",
    amount: 100, // dollars at the API boundary
    bankAccountId: bank.id,
  });
  const paid = await apiGet(request, `/api/invoices/${invoice.id}`);
  expect(paid.status).toBe("paid");

  // The ledger still balances after payment (Dr Bank / Cr A/R).
  const tbAfter = await apiGet(request, "/api/reports/trial-balance?asOf=2026-07-10");
  expect(tbAfter.totalDebit).toBe(tbAfter.totalCredit);

  // ---- 5. NAVIGATE the critical-flow pages in the real UI ------------------
  // Invoices list renders the invoice we created. A full reload is needed
  // because the app caches queries with staleTime: Infinity, and the invoice
  // was created out-of-band via the API — reload() refetches fresh data.
  await page.goto("/#/invoices");
  await page.reload();
  await expect(page.getByTestId("text-page-title")).toBeVisible();
  const invoiceRow = page.getByTestId(`row-invoice-${invoice.id}`);
  await expect(invoiceRow).toBeVisible({ timeout: 15_000 });
  await expect(invoiceRow).toContainText("E2E Customer");

  // Bank reconciliation page loads (full match flow is covered by the server
  // integration suite; here we assert the page mounts without crashing).
  await page.goto("/#/reconciliation");
  await expect(page.getByTestId("text-page-title")).toBeVisible();
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);

  // Reports → Trial Balance tab renders in the UI.
  await page.goto("/#/reports");
  await page.getByTestId("tab-tb").click();
  await expect(page.getByTestId("input-tb-asof")).toBeVisible({ timeout: 15_000 });
});
