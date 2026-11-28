import { defineConfig, devices } from '@playwright/test';
import { DRAFT_PROPOSAL_TIMING } from '@pertexo/contracts';
import { failureArtifactJourney } from '../../infrastructure/testing/live-failure-artifacts.mjs';

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

const LIVE_JOURNEYS = '**/*.spec.ts';
const TRIGGER_RECURRENCE_JOURNEY = '**/manual-trigger-pause.spec.ts';

function testMatch() {
  if (process.env.PERTEXO_BROWSER_LIFETIME_PROBE !== undefined)
    return '**/*.lifetime-probe.ts';
  if (process.env.PERTEXO_HTTP_REDACTION_PROBE === 'true')
    return '**/http-secret-actions.probe.ts';
  if (process.env.PERTEXO_VERIFICATION_REDACTION_PROBE === 'true')
    return '**/verification-navigation.probe.ts';
  return LIVE_JOURNEYS;
}

// Only a journey listed in live-failure-artifacts.mjs (run-only accounts on a
// disposable database, no step secrets) keeps a trace and a screenshot of a
// failure, so a flake that never reproduces locally can be read from CI.
// Every other journey keeps them off: its pages can show typed secrets.
const failureArtifacts = failureArtifactJourney(process.env);

// The API journey owner validates PERTEXO_LIVE_WEB_PORT, serves the preview
// there and passes its origin, so the port has one reading.
const liveWebOrigin = process.env.PERTEXO_LIVE_WEB_ORIGIN;
if (liveWebOrigin === undefined)
  throw new Error(
    'PERTEXO_LIVE_WEB_ORIGIN is missing: run live journeys through their apps/api integration test.',
  );

const JOURNEY_TIMEOUT_MILLIS = 60_000;
const selectedTests = testMatch();

export default defineConfig({
  testDir: './e2e-live',
  // Playwright empties this when it starts, and journeys run side by side.
  outputDir: `test-results/live-${new URL(liveWebOrigin).port}${failureArtifacts === undefined ? '' : `/${failureArtifacts}`}`,
  testMatch: selectedTests,
  ...(selectedTests === LIVE_JOURNEYS
    ? {
        projects: [
          { testIgnore: TRIGGER_RECURRENCE_JOURNEY },
          {
            name: 'trigger recurrence',
            testMatch: TRIGGER_RECURRENCE_JOURNEY,
            // The schedule fires once while paused and once after resume, a minute apart.
            timeout: 180_000,
          },
        ],
      }
    : {}),
  forbidOnly: true,
  retries: 0,
  workers: 1,
  // The opt-in real-model evaluation (draft-evaluation.spec.ts) may spend a
  // whole proposal budget in one case, on top of the usual journey setup.
  timeout:
    process.env.PERTEXO_AUTHORING_EVAL_ORIGIN === undefined
      ? JOURNEY_TIMEOUT_MILLIS
      : JOURNEY_TIMEOUT_MILLIS + DRAFT_PROPOSAL_TIMING.requestMillis,
  use: {
    baseURL: liveWebOrigin,
    // Live authentication cookies/verification URLs must not become artifacts,
    // except for a journey that asked for failure artifacts (above).
    trace: failureArtifacts === undefined ? 'off' : 'retain-on-failure',
    screenshot: failureArtifacts === undefined ? 'off' : 'only-on-failure',
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
