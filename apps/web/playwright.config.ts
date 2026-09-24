import { defineConfig, devices } from '@playwright/test';

const criticalSmoke =
  /signs in, selects a workspace, and signs out|keeps the mobile workspace drawer bounded and keyboard accessible|creates the first workspace from the keyboard-accessible empty state|keeps keyboard placement usable and the narrow editor horizontally bounded/u;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? {
              launchOptions: {
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
              },
            }
          : {}),
      },
    },
    {
      name: 'firefox-smoke',
      grep: criticalSmoke,
      use: devices['Desktop Firefox'],
    },
    {
      name: 'webkit-smoke',
      grep: criticalSmoke,
      use: devices['Desktop Safari'],
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
