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

// The journeys Firefox and WebKit run on every change, tagged where they
// live so a renamed title cannot drop one.
const criticalSmoke = /@every-browser/u;

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

export default defineConfig<object, CoverageOptions>({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  // A test that passes on a rerun is a flake to fix, so nothing retries.
  retries: 0,
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    coverageDirectory: overlapCoverage,
  },
  projects: [
    { name: 'chromium', use: chromium },
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
