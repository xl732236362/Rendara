import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 45_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node tests/e2e/fixtures/agent-provider.mjs",
      url: "http://127.0.0.1:3199/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @loomic/server dev:server",
      url: "http://127.0.0.1:3101/api/health",
      env: {
        LOOMIC_SERVER_PORT: "3101",
        LOOMIC_WEB_ORIGIN: "http://127.0.0.1:3100",
        OPENAI_API_KEY: "e2e-fixture-key",
        OPENAI_API_BASE: "http://127.0.0.1:3199/v1",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @loomic/web exec next dev -p 3100",
      url: "http://127.0.0.1:3100/login",
      env: {
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_SERVER_BASE_URL: "http://127.0.0.1:3101",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
