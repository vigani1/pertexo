import { noFlakeMasking } from './no-flake-masking.mjs';
import { ratchetCases, tester } from './rule-tester.mjs';

const unit = 'packages/demo/test/unit.test.ts';
const integration = 'packages/demo/test/slow.integration.test.ts';
const lanes = [
  { files: ['**'], testTimeout: 5_000, hookTimeout: 10_000 },
  {
    files: ['packages/demo/test/**/*.integration.*'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
];
const options = [{ lanes }];
const valid = (name, code, filename = unit) => ({
  name,
  code,
  filename,
  options,
});
const invalid = (name, code, messageId, filename = unit) => ({
  name,
  code,
  filename,
  options,
  errors: [{ messageId }],
});

tester.run('no-flake-masking', noFlakeMasking, {
  valid: [
    valid('a timeout within the lane', `it('x', async () => {}, 4_000);`),
    valid('a test given by reference', `it('x', checkSomething);`),
    valid('a hook given by reference', `beforeAll(setUp);`),
    valid(
      'a longer timeout within its integration lane',
      `beforeAll(async () => {}, 60_000); it('x', async () => {}, 30_000);`,
      integration,
    ),
    valid(
      'a timeout option within the lane',
      `it('x', { timeout: 1_000 }, async () => {});`,
    ),
    valid(
      'a lane timeout that says why',
      `export default defineConfig({
        test: {
          // Four files at once beside PostgreSQL.
          testTimeout: 30_000,
        },
      });`,
      'packages/demo/vitest.integration.config.ts',
    ),
    valid(
      'a Playwright config without retries',
      `export default defineConfig({ retries: 0 });`,
      'apps/demo/playwright.config.ts',
    ),
    valid(
      'a product retry policy under test',
      `it('retries the step', () => { const policy = { retries: 3 }; expect(plan(policy)).toBe(3); });`,
    ),
    valid(
      'a fake-timer advance',
      `it('x', async () => { await vi.advanceTimersByTimeAsync(60_000); });`,
    ),
  ],
  invalid: [
    invalid(
      'a test timeout above the unit lane',
      `it('x', async () => {}, 60_000);`,
      'timeout',
    ),
    invalid(
      'a hook timeout above the lane',
      `beforeAll(async () => {}, 20_000);`,
      'timeout',
    ),
    invalid(
      'a test timeout above the integration lane',
      `it('x', async () => {}, 120_000);`,
      'timeout',
      integration,
    ),
    invalid(
      'a timeout the rule cannot read',
      `import { LIMIT } from './limits.js'; it('x', async () => {}, LIMIT);`,
      'timeout',
    ),
    invalid(
      'a constant above the lane',
      `const LIMIT = 60 * 1_000; it('x', async () => {}, LIMIT);`,
      'timeout',
    ),
    invalid(
      'a table test above the lane',
      `it.each([1])('x %s', async () => {}, 60_000);`,
      'timeout',
    ),
    invalid(
      'a suite timeout option',
      `describe('x', { timeout: 60_000 }, () => {});`,
      'timeout',
    ),
    invalid(
      'a per-test retry',
      `it('x', { retry: 2 }, async () => {});`,
      'retry',
    ),
    invalid(
      'a Playwright suite retry',
      `test.describe.configure({ retries: 2 });`,
      'retry',
    ),
    invalid(
      'Playwright retries on CI',
      `export default defineConfig({ retries: process.env.CI ? 2 : 0 });`,
      'retry',
      'apps/demo/playwright.config.ts',
    ),
    invalid(
      'a Vitest config retry',
      `export default defineConfig({ test: { retry: 1 } });`,
      'retry',
      'packages/demo/vitest.config.ts',
    ),
    invalid(
      'a lane timeout without a reason',
      `export default defineConfig({ test: { testTimeout: 30_000 } });`,
      'reason',
      'packages/demo/vitest.integration.config.ts',
    ),
    invalid(
      'a test marked slow',
      `test('x', async () => { test.slow(); });`,
      'slow',
    ),
    invalid(
      'a Playwright timeout raised inside a test',
      `test('x', async () => { test.setTimeout(120_000); });`,
      'timeout',
    ),
    invalid(
      'a raised Vitest config at run time',
      `vi.setConfig({ testTimeout: 60_000 });`,
      'timeout',
    ),
  ],
});

tester.run(
  'no-flake-masking ratchet',
  noFlakeMasking,
  ratchetCases({
    filename: unit,
    count: 1,
    options: { lanes },
    code: `it('x', async () => {}, 60_000);`,
  }),
);
