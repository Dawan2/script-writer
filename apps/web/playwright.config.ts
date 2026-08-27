import { defineConfig, devices } from "@playwright/test";

// 端到端测试跑真实浏览器，用于 jsdom 覆盖不到的过程类验收：
// 关标签页确认、跨页跳转与后退、真实焦点与滚动、SSE 长连接。
// 它需要浏览器内核与本地服务，因此不进 npm test 的默认链条，单独用 npm run test:web:e2e 触发。
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next dev --port ${PORT}`,
    env: { SCRIPT_SYNC_LOCAL_MODE: "1", NEXT_DIST_DIR: ".next-e2e" },
    url: `http://127.0.0.1:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI
  }
});
