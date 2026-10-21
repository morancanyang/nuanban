import { defineConfig, devices } from '@playwright/test';
// 既有用例默认以「已选择游客模式」启动，避免每次都被欢迎页拦截；入口页用例自行清空 storageState。
const guestEntry = { cookies: [], origins: [{ origin: 'http://127.0.0.1:5173', localStorage: [{ name: 'nuanban.entry.v1', value: JSON.stringify({ mode: 'guest', at: '2026-01-01T00:00:00.000Z' }) }] }] };
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, storageState: guestEntry },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
});
