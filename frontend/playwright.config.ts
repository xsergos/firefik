import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: process.env.CI
    ? undefined
    : {
        command: `${process.env.npm_execpath ?? "npm"} run dev`,
        url: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
