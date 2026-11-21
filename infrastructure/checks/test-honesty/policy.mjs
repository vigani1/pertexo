import fixedSleeps from './no-fixed-sleep.allow.json' with { type: 'json' };
import flakeMasking from './no-flake-masking.allow.json' with { type: 'json' };
import internalDoubles from './no-internal-test-doubles.allow.json' with { type: 'json' };
import unsignaledPolls from './no-unsignaled-poll.allow.json' with { type: 'json' };

/** Where test code lives, repository-relative. */
const TEST_CODE = Object.freeze([
  'apps/*/test/**',
  'packages/*/test/**',
  // Also named for the web config, which sees only paths below apps/web.
  'apps/web/test/**',
  'apps/web/e2e/**',
  'apps/web/e2e-live/**',
  'packages/database/src/testing/**',
  '**/*.test.{ts,tsx,mts,mjs}',
  '**/*.spec.ts',
]);

/** Lane configs, where retries and lane timeouts are set. */
const TEST_CONFIGS = Object.freeze([
  '**/vitest*.config.ts',
  '**/playwright*.config.ts',
  'infrastructure/testing/worker-databases.mjs',
]);

const VITEST_DEFAULT = { testTimeout: 5_000, hookTimeout: 10_000 };
const parallelIntegration = { testTimeout: 30_000, hookTimeout: 60_000 };
const appIntegration = { testTimeout: 30_000, hookTimeout: 30_000 };
const resilience = { testTimeout: 240_000, hookTimeout: 120_000 };

/**
 * Each lane's configured timeouts, by the files it runs; the last match wins.
 * Support files without a lane suffix take their package's unit lane. The
 * lanes test checks every entry against the Vitest config that owns it.
 */
export const LANES = Object.freeze([
  { files: ['**'], ...VITEST_DEFAULT },
  // node:test has no default timeout.
  { files: ['infrastructure/**'], testTimeout: null, hookTimeout: null },
  {
    files: ['apps/code-runner/test/**'],
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
  { files: ['apps/web/test/**'], testTimeout: 30_000, hookTimeout: 10_000 },
  // Playwright: hooks share the test timeout.
  { files: ['apps/web/e2e/**'], testTimeout: 30_000, hookTimeout: 30_000 },
  { files: ['apps/web/e2e-live/**'], testTimeout: 60_000, hookTimeout: 60_000 },
  {
    files: ['apps/api/test/main-process.test.ts'],
    ...VITEST_DEFAULT,
    testTimeout: 11_000,
  },
  {
    files: ['apps/ops/test/main-process.test.ts'],
    ...VITEST_DEFAULT,
    testTimeout: 32_000,
  },
  {
    files: ['apps/worker/test/main-process.test.ts'],
    ...VITEST_DEFAULT,
    testTimeout: 17_000,
  },
  {
    files: [
      'apps/{api,worker}/test/**/*.integration.test.ts',
      'apps/{api,worker}/test/**/*.integration.support.ts',
    ],
    ...appIntegration,
  },
  {
    files: [
      'packages/{core,database,secrets}/test/**/*.integration.test.ts',
      'packages/{core,database,secrets}/test/**/*.integration.support.ts',
    ],
    ...parallelIntegration,
  },
  {
    files: ['apps/{api,worker}/test/**/*.resilience.integration.test.ts'],
    ...resilience,
  },
]);

/** Each rule's ratchet: file → exact count of violations it still has. */
export const ALLOWLISTS = Object.freeze({
  'no-fixed-sleep': fixedSleeps,
  'no-unsignaled-poll': unsignaledPolls,
  'no-internal-test-doubles': internalDoubles,
  'no-flake-masking': flakeMasking,
});

const SCOPES = {
  'no-fixed-sleep': { files: TEST_CODE },
  'no-unsignaled-poll': { files: TEST_CODE },
  'no-internal-test-doubles': { files: TEST_CODE },
  'no-flake-masking': { files: [...TEST_CODE, ...TEST_CONFIGS], lanes: LANES },
};

/**
 * The test-honesty rules as Oxlint overrides for a config at `base`
 * (repository-relative, '' for the root), with each rule's ratchet.
 */
export function testHonestyOverrides(base = '', allowlists = ALLOWLISTS) {
  return Object.entries(SCOPES)
    .map(([rule, { files, lanes }]) => ({
      files: files.flatMap((glob) => fromBase(glob, base)),
      rules: {
        [`test-honesty/${rule}`]: [
          'error',
          { allow: allowlists[rule], ...(lanes ? { lanes } : {}) },
        ],
      },
    }))
    .filter((override) => override.files.length > 0);
}

function fromBase(glob, base) {
  if (base === '' || glob.startsWith('**/')) return [glob];
  return glob.startsWith(`${base}/`) ? [glob.slice(base.length + 1)] : [];
}
