import { defineConfig } from "@playwright/test";

/**
 * Drives the real page against the real local backend. `scripts/dev.mjs` brings the anonymous
 * Convex backend up before Vite, so by the time 5173 answers the queries behind the page exist.
 * No Tinybird credentials: the test asserts the inert-delivery state the page must explain.
 */
const port = Number(process.env.DEMO_PORT ?? 5173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/dev.mjs",
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
