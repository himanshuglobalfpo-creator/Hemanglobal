// ============================================================================
// Shared E2E helpers — signup + authenticated API against the live server
// ============================================================================
// Every spec signs up its own fresh org (isolated data), then drives the real
// server API using the session + CSRF cookies the UI signup established.

import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

export function uniqueUser(tag: string) {
  const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    name: `E2E ${tag}`,
    org: `E2E ${tag} ${uniq}`,
    email: `e2e-${tag}-${uniq}@example.com`,
    password: "Ledger$ecure99", // ≥10 chars, 3+ classes, no email local part
  };
}

// Sign up through the real UI and land in the app shell.
export async function signup(page: Page, user: { name: string; org: string; email: string; password: string }) {
  await page.goto("/");
  await page.getByTestId("link-to-signup").click();
  await page.getByTestId("input-signup-name").fill(user.name);
  await page.getByTestId("input-signup-org").fill(user.org);
  await page.getByTestId("input-signup-email").fill(user.email);
  await page.getByTestId("input-signup-password").fill(user.password);
  await page.getByTestId("checkbox-signup-terms").check();
  await page.getByTestId("button-signup").click();
  await expect(page.getByTestId("text-page-title")).toBeVisible({ timeout: 15_000 });
}

export async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const cookies = await context.cookies();
  // Production hardening prefixes the cookie (__Host-ll_csrf); read either name.
  const csrf = cookies.find((c) => c.name === "__Host-ll_csrf" || c.name === "ll_csrf")?.value;
  return csrf ? { "x-csrf-token": csrf, "content-type": "application/json" } : { "content-type": "application/json" };
}

export async function apiGet(request: APIRequestContext, url: string) {
  const res = await request.get(url);
  expect(res.ok(), `GET ${url} → ${res.status()}`).toBeTruthy();
  return res.json();
}

export async function apiPost(context: BrowserContext, request: APIRequestContext, url: string, data: unknown) {
  const res = await request.post(url, { headers: await csrfHeaders(context), data });
  expect(res.ok(), `POST ${url} → ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
  return res.json();
}
