import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const runNode = promisify(execFile);

async function observeCron(input: {
  timezone: string;
  expression: string;
  anchorAt: string;
  observedAt: string;
}): Promise<unknown> {
  // A separate process makes a synchronous recurrence regression fail within
  // a deadline instead of trapping the test runner's own event loop.
  const moduleUrl = new URL(
    '../src/triggers/schedule-recurrence.ts',
    import.meta.url,
  ).href;
  const { stdout } = await runNode(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { resolveScheduleObservation } from ${JSON.stringify(moduleUrl)};
const input = ${JSON.stringify(input)};
console.log(JSON.stringify(resolveScheduleObservation(
  { kind: 'cron', expression: input.expression, timezone: input.timezone },
  new Date(input.anchorAt),
  new Date(input.observedAt),
)));`,
    ],
    { timeout: 5_000, killSignal: 'SIGKILL' },
  );
  return JSON.parse(stdout);
}

it.each([
  [
    '2026-10-25T00:00:00.000Z',
    '2026-10-25T00:00:00.000Z',
    '2026-10-25T00:05:00.000Z',
  ],
  [
    '2026-10-25T00:55:00.000Z',
    '2026-10-25T00:55:00.000Z',
    '2026-10-25T02:00:00.000Z',
  ],
  [
    '2026-10-25T01:00:00.000Z',
    '2026-10-25T00:55:00.000Z',
    '2026-10-25T02:00:00.000Z',
  ],
  [
    '2026-10-25T01:30:00.000Z',
    '2026-10-25T00:55:00.000Z',
    '2026-10-25T02:00:00.000Z',
  ],
  [
    '2026-10-25T01:59:59.999Z',
    '2026-10-25T00:55:00.000Z',
    '2026-10-25T02:00:00.000Z',
  ],
  [
    '2026-10-25T02:00:00.000Z',
    '2026-10-25T02:00:00.000Z',
    '2026-10-25T02:05:00.000Z',
  ],
])(
  'advances across a repeated hour at %s',
  async (observedAt, greatestDueAt, nextAt) => {
    await expect(
      observeCron({
        expression: '*/5 * * * *',
        timezone: 'Europe/Berlin',
        anchorAt: '2026-10-24T00:00:00.000Z',
        observedAt,
      }),
    ).resolves.toEqual({ greatestDueAt, nextAt });
  },
  10_000,
);

it('does not re-accept an earlier local occurrence after restart inside the repeated hour', async () => {
  await expect(
    observeCron({
      expression: '*/5 * * * *',
      timezone: 'Europe/Berlin',
      anchorAt: '2026-10-25T00:55:00.000Z',
      observedAt: '2026-10-25T01:30:00.000Z',
    }),
  ).resolves.toEqual({
    greatestDueAt: null,
    nextAt: '2026-10-25T02:00:00.000Z',
  });
}, 10_000);

it('handles a half-hour backward transition without assuming a one-hour DST shift', async () => {
  await expect(
    observeCron({
      expression: '*/5 * * * *',
      timezone: 'Australia/Lord_Howe',
      anchorAt: '2026-04-03T00:00:00.000Z',
      observedAt: '2026-04-04T15:00:00.000Z',
    }),
  ).resolves.toEqual({
    greatestDueAt: '2026-04-04T14:55:00.000Z',
    nextAt: '2026-04-04T15:30:00.000Z',
  });
}, 10_000);

it.each(['2026-03-08T07:00:00.000Z', '2026-03-08T07:15:00.000Z'])(
  'retains the first-valid-instant spring-gap occurrence at %s',
  async (observedAt) => {
    await expect(
      observeCron({
        expression: '0,30 2 * * *',
        timezone: 'America/New_York',
        anchorAt: '2026-03-07T07:30:00.000Z',
        observedAt,
      }),
    ).resolves.toEqual({
      greatestDueAt: '2026-03-08T07:00:00.000Z',
      nextAt: '2026-03-09T06:00:00.000Z',
    });
  },
  10_000,
);

it('finds the latest missed occurrence without enumerating years of backlog', async () => {
  await expect(
    observeCron({
      expression: '* * * * *',
      timezone: 'Europe/Berlin',
      anchorAt: '2000-01-01T00:00:00.000Z',
      observedAt: '2026-10-25T01:30:00.000Z',
    }),
  ).resolves.toEqual({
    greatestDueAt: '2026-10-25T00:59:00.000Z',
    nextAt: '2026-10-25T02:00:00.000Z',
  });
}, 10_000);
