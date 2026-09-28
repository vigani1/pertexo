import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-live',
  testMatch:
    process.env.PERTEXO_BROWSER_LIFETIME_PROBE !== undefined
      ? '**/*.lifetime-probe.ts'
      : process.env.PERTEXO_VERIFICATION_REDACTION_PROBE === 'true'
        ? '**/*.probe.ts'
        : '**/*.spec.ts',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    // Live authentication cookies/verification URLs must not become artifacts.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ...devices['Desktop Chrome'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          },
        }
      : {}),
  },
  // The API integration owner builds and owns Vite's process group directly.
  // No nested pnpm/webServer shell may survive fixture teardown.
});
