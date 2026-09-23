import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite for the core mining loop.
 *
 * It drives the real local dev pair (vite on :5173 proxying /api to the Worker on :8787, see
 * vite.config.ts and scripts/dev-local.mjs), so every assertion travels the same HTTP path a
 * player's browser uses. An already running "npm run dev:local" is reused; when it is not running
 * Playwright starts it and shuts it down again at the end of the run.
 *
 * Test files are matched as *.e2e.ts on purpose: vitest owns *.test.ts and *.spec.ts across the
 * repo and would otherwise collect this directory with the wrong runner.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  // The suite drives the shared local D1 through the Worker, so tests stay ordered inside a file
  // and each file keeps one worker. Every worker also gets its own wallet (see e2e/fixtures).
  //
  // Parallelism is capped at two on purpose: the Worker rate-limits /api/auth/* to 12 requests per
  // IP per minute (worker/http.ts) and every browser in a run shares one IP, so a wider fan-out
  // spends the budget on signing in. The retry absorbs the other shared-resource hazard here, a
  // dev server that another agent's edit restarts mid-run.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]]
    : [["list"]],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:5173",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:local",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
  },
});
