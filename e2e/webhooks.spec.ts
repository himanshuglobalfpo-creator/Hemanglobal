// E2E — Settings webhooks: create, test-fire, deliveries log.
import { test, expect } from "@playwright/test";
import { uniqueUser, signup, apiGet } from "./helpers";

test("webhooks: create → test-fire → delivery queued", async ({ page }) => {
  await signup(page, uniqueUser("wh"));
  const request = page.request;

  await page.goto("/#/settings");
  await page.reload();
  await expect(page.getByTestId("card-webhooks")).toBeVisible({ timeout: 15_000 });

  // Create a webhook. A literal public IP avoids DNS while passing the SSRF guard.
  await page.getByTestId("button-new-webhook").click();
  await page.getByTestId("input-webhook-url").fill("https://1.1.1.1/ledgerlite-hook");
  await page.getByTestId("input-webhook-secret").fill("supersecretsigningkey123");
  await page.getByTestId("button-save-webhook").click();

  // It appears in the list.
  await expect.poll(async () => (await apiGet(request, "/api/webhooks")).length, { timeout: 15_000 }).toBe(1);
  const [hook] = await apiGet(request, "/api/webhooks");
  await expect(page.getByTestId(`row-webhook-${hook.id}`)).toBeVisible();

  // Test-fire enqueues a "ping" delivery.
  await page.getByTestId(`button-test-webhook-${hook.id}`).click();
  await expect.poll(async () => {
    const deliveries = await apiGet(request, `/api/webhooks/${hook.id}/deliveries`);
    return deliveries.some((d: any) => d.event === "ping");
  }, { timeout: 15_000 }).toBeTruthy();

  // The deliveries dialog shows it.
  await page.getByTestId(`button-deliveries-webhook-${hook.id}`).click();
  await expect(page.getByTestId("panel-deliveries")).toContainText("ping", { timeout: 10_000 });
});
