import { defineConfig, devices } from '@playwright/test';
import type { CoverageOptions } from './e2e/support/coverage';

const webPort = Number(process.env.PERTEXO_MOCK_WEB_PORT ?? 4173);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
  throw new Error('Invalid mocked browser port');
const webOrigin = `http://127.0.0.1:${String(webPort)}`;

// Set only by the hand-started overlap run
// (infrastructure/testing/overlap/run-spec-coverage.mjs): it builds the app
// once with source maps, and each spec records its JavaScript coverage here.
const overlapCoverage = process.env.PERTEXO_OVERLAP_BROWSER_COVERAGE;
const preview = `pnpm preview --port ${String(webPort)} --strictPort`;

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
  // Focusing a step and pressing Enter right after creating the workflow
  // sometimes never shows its Label field (CI, 9 of 1,483 jobs). Not
  // reproduced locally in 365 runs at 4-8x CPU throttling, so the cause is
  // still open.
  '**/workflow-editor/steps/file-pages.spec.ts',
];

export default defineConfig<object, CoverageOptions>({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    coverageDirectory: overlapCoverage,
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
    command:
      overlapCoverage === undefined
        ? `pnpm exec vite build && ${preview}`
        : preview,
    url: webOrigin,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
