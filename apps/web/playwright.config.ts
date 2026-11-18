import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.PERTEXO_MOCK_WEB_PORT ?? 4173);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
  throw new Error('Invalid mocked browser port');
const webOrigin = `http://127.0.0.1:${String(webPort)}`;

const criticalSmoke =
  /signs in, lands in the only workspace, and signs out|keeps the mobile workspace bar and More sheet bounded and keyboard accessible|creates the first workspace from the keyboard-accessible empty state|keeps keyboard placement usable and the narrow editor horizontally bounded|two-factor setup and challenge at 375px/u;

const chromium = {
  ...devices['Desktop Chrome'],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? {
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        },
      }
    : {}),
};

// A test that passes on a rerun is a flake to fix, so nothing retries except
// these specs, which still flaked on CI after reduced motion, each with the
// cause found so far. Delete an entry once its cause is fixed.
const stillFlaky = [
  // Selecting a step right after the editor opens sometimes never opens
  // its inspector: the Label field is never shown (CI, 320px and 1920px).
  '**/workflow-editor/chrome/header.spec.ts',
  '**/workflow-editor/steps/file-pages.spec.ts',
  // Inserting data by keyboard at 320px sometimes saves an empty data
  // reference ("a" &  & "b"): the keyboard choice lands before the list is ready.
  '**/workflow-editor/inspector/condition-and-insert-data.spec.ts',
];

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'chromium', testIgnore: stillFlaky, use: chromium },
    {
      name: 'chromium-still-flaky',
      testMatch: stillFlaky,
      retries: process.env.CI ? 1 : 0,
      use: chromium,
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
    // No typecheck here: `pnpm check` owns it, and it took nearly all of this start.
    command: `pnpm exec vite build && pnpm preview --port ${String(webPort)} --strictPort`,
    url: webOrigin,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
