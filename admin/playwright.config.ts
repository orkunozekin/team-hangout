import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:4177",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  },
  webServer: {
    command: "yarn preview --port 4177 --strictPort",
    url: "http://127.0.0.1:4177",
    reuseExistingServer: false,
  },
});
