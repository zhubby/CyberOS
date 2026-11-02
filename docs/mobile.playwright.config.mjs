import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web-tests",
  outputDir: "../.cyberos/mobile-browser/results",
  workers: 2,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5175", headless: true, screenshot: "only-on-failure" },
  webServer: {
    command: "npm --prefix .. run dev -w @cyberos/web -- --port 5175",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: true,
  },
});
