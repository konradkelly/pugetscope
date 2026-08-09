import { defineConfig, devices } from "@playwright/test";

// No `webServer` here on purpose — CI/local both bring up the docker-compose
// stack (postgres redis api websocket frontend, deliberately omitting
// ingestion — see fixtures/seed.ts) and seed it as separate steps before
// `playwright test` runs, so a stack-health failure and a Playwright-launch
// failure are never conflated into the same error.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:8090",
    trace: "retain-on-failure",
    // Real notification-permission prompts would otherwise block any spec
    // that touches push-alert UI; none of the current specs do, but this is
    // harmless to set globally and saves the next spec author from hitting it.
    permissions: ["notifications"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
