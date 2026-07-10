import { defineConfig, devices } from "@playwright/test";

// E2E config. The webServer boots the production build against a throwaway
// Postgres (scripts/e2e-server.mjs) and Playwright waits for the health check
// before running specs. Run with: npm run test:e2e (after `npm run build`).
const PORT = process.env.E2E_PORT || "5099";
const BASE_URL = `http://localhost:${PORT}`;

// The environment pre-installs Chromium at /opt/pw-browsers; honor an explicit
// executable path when provided so we never try to download a browser.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: executablePath ? { executablePath } : {} },
    },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `${BASE_URL}/api/health/live`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
