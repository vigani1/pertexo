import { defineConfig, devices } from '@playwright/test';

// Playwright also saves ARIA error-context snapshots independently of trace,
// video and screenshots. Live pages may reveal transient test credentials.
// Only the isolated dummy-secret probe may demonstrate the unprotected path.
const unprotectedSnapshotProbe =
  process.env.PERTEXO_HTTP_REDACTION_PROBE === 'true' &&
  process.env.PERTEXO_HTTP_REDACTION_SNAPSHOT_CONTROL === 'unprotected' &&
  process.env.PERTEXO_LIVE_MAIL_ORIGIN === undefined &&
  process.env.EDITOR_BROWSER_INTEGRATION !== 'true';
if (unprotectedSnapshotProbe) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
else process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

function testMatch() {
  if (process.env.PERTEXO_BROWSER_LIFETIME_PROBE !== undefined)
    return '**/*.lifetime-probe.ts';
  if (process.env.PERTEXO_HTTP_REDACTION_PROBE === 'true')
    return '**/http-secret-actions.probe.ts';
  if (process.env.PERTEXO_VERIFICATION_REDACTION_PROBE === 'true')
    return '**/verification-navigation.probe.ts';
  return '**/*.spec.ts';
}

// The API journey owner validates PERTEXO_LIVE_WEB_PORT, serves the preview
// there and passes its origin, so the port has one reading.
const liveWebOrigin = process.env.PERTEXO_LIVE_WEB_ORIGIN;
if (liveWebOrigin === undefined)
  throw new Error(
    'PERTEXO_LIVE_WEB_ORIGIN is missing: run live journeys through their apps/api integration test.',
  );

export default defineConfig({
  testDir: './e2e-live',
  testMatch: testMatch(),
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: liveWebOrigin,
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
