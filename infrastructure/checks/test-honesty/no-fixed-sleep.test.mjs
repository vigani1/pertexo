import { noFixedSleep } from './no-fixed-sleep.mjs';
import { ratchetCases, tester } from './rule-tester.mjs';

const file = 'apps/api/test/sleeps.test.ts';
const sleep = { messageId: 'sleep' };
const valid = (name, code, filename = file) => ({ name, code, filename });
const invalid = (name, code, errors = [sleep], filename = file) => ({
  name,
  code,
  filename,
  errors,
});

tester.run('no-fixed-sleep', noFixedSleep, {
  valid: [
    valid(
      'a mock implementation simulating a slow service',
      `it('waits for the slow lookup', async () => {
        lookup.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'ok';
        });
        await expect(run()).resolves.toBe('ok');
      });`,
    ),
    valid(
      'a route handler answering late',
      `test('arrives late', async ({ page }) => {
        await page.route('**/v1/**', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await route.fallback();
        });
      });`,
    ),
    valid(
      'a fake transport handed to the code under test',
      `import { setTimeout as delay } from 'node:timers/promises';
      const service = createService({
        encryption: { open: async () => { await delay(5); return key; } },
      });`,
    ),
    valid(
      'a stream that yields slowly',
      `import { setTimeout as delay } from 'node:timers/promises';
      server.get('/stream', () => Readable.from((async function* () {
        yield 'a';
        await delay(100);
        yield 'b';
      })()));`,
    ),
    valid(
      'a poll loop pacing a condition it checks',
      `import { setTimeout as delay } from 'node:timers/promises';
      it('sees the row', async () => {
        while (!(await rowExists())) await delay(25);
      });`,
    ),
    valid(
      'a global-timer sleep under fake timers',
      `it('advances', async () => {
        vi.useFakeTimers();
        void vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      });`,
    ),
    valid(
      'a sleep helper defined but never called',
      `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`,
    ),
    valid(
      'a simulated run started by the fake consumer',
      `import { setTimeout as sleep } from 'node:timers/promises';
      const start = async (event) => { await sleep(40); await commit(event); };
      consume({ start });`,
    ),
  ],
  invalid: [
    invalid(
      'a promise a timer resolves in a test',
      `it('saves', async () => {
        save();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(saved()).toBe(true);
      });`,
    ),
    invalid(
      'setTimeout from node:timers/promises in a hook, under another name',
      `import { setTimeout as wait } from 'node:timers/promises';
      beforeEach(async () => { await wait(50); });`,
    ),
    invalid(
      'a timers/promises namespace',
      `import timers from 'node:timers/promises';
      it('x', async () => { await timers.setTimeout(10); });`,
    ),
    invalid(
      'Playwright waitForTimeout',
      `test('x', async ({ page }) => { await page.waitForTimeout(1_000); });`,
      [sleep],
      'apps/web/e2e/x.spec.ts',
    ),
    invalid(
      'a node:timers/promises sleep is real even under fake timers',
      `import { setTimeout as delay } from 'node:timers/promises';
      it('x', async () => { vi.useFakeTimers(); await delay(10); });`,
    ),
    invalid(
      'a local sleep helper, counted where it is called',
      `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      it('x', async () => { await sleep(10); await sleep(20); });`,
      [sleep, sleep],
    ),
    invalid(
      'a sleep helper wrapped in act',
      `const settle = () => act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      it('x', async () => { await settle(); });`,
    ),
    invalid(
      'a helper the test calls that sleeps before reading',
      `async function logsOf(auth) {
        await auth.check();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return output();
      }
      it('x', async () => { expect(await logsOf(auth)).toBe(''); });`,
    ),
    invalid(
      'a callback the test runs and awaits',
      `it('x', async () => {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      });`,
    ),
    invalid(
      'a fixture object method the test calls',
      `export function session() {
        return {
          expectNothingSaved: async () => {
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(saves).toEqual([]);
          },
        };
      }`,
    ),
    invalid(
      'a listed sleep helper imported from test support',
      `import { delay } from '../support/recovery/facts.js';
      it('x', async () => { await delay(4_000); });`,
      [sleep],
      'apps/worker/test/recovery/outage.test.ts',
    ),
    invalid(
      'an exported sleep helper that is not listed',
      `export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`,
      [{ messageId: 'helper' }],
    ),
    invalid(
      'a listed helper that no longer only sleeps',
      `export const delay = (ms) => { log(ms); return Promise.resolve(); };`,
      [{ messageId: 'unlisted', data: { name: 'delay' } }],
      'apps/worker/test/support/recovery/facts.ts',
    ),
  ],
});

tester.run(
  'no-fixed-sleep ratchet',
  noFixedSleep,
  ratchetCases({
    filename: file,
    count: 2,
    code: `it('x', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 2));
    });`,
  }),
);
