import { defineConfig } from '@playwright/test';

/**
 * 固定为仓库内 .local-browsers（见 `npx playwright install`）。
 * 避免上游环境将 PLAYWRIGHT_BROWSERS_PATH 指到未下载浏览器的目录。
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
