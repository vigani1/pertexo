import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.PERTEXO_MOCK_WEB_PORT ?? 4173);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
  throw new Error('Invalid mocked browser port');
const webOrigin = `http://127.0.0.1:${String(webPort)}`;

const criticalSmoke =
  /signs in, lands in the only workspace, and signs out|keeps the mobile workspace bar and More sheet bounded and keyboard accessible|creates the first workspace from the keyboard-accessible empty state|keeps keyboard placement usable and the narrow editor horizontally bounded|two-factor setup and challenge at 375px/u;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: webOrigin, trace: 'retain-on-failure' },
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
    command: `pnpm build && pnpm preview --port ${String(webPort)} --strictPort`,
    url: webOrigin,
    reuseExistingServer: false,
    // Starting includes a full typecheck and a production build.
    timeout: 180_000,
  },
});
