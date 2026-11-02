import {
  beforeEachFixture1,
  beforeEachFixture2,
  seams,
  ids,
  claim,
  scannerWithClaims,
  scanInput,
  completion,
  hourlyClaim,
  recordAdmissionTransactions,
  runId,
} from './scanner/fixture.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createHash } from 'node:crypto';

describe('schedule trigger scanner claim ownership', () => {
  beforeEach(beforeEachFixture1);
  it('performs no claim work for a pre-aborted scan', async () => {
    const reason = new Error('stop before checkout');
    const controller = new AbortController();
    controller.abort(reason);
    const { queries, scanner } = scannerWithClaims([]);

    await expect(
      scanner.scanDue({ ...scanInput, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(queries).toEqual([]);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('never cleans up a malformed identity and releases every valid sibling', async () => {
    const malformed = claim('not-a-uuid', ids.leaseOne);
    const valid = claim(ids.triggerTwo, ids.leaseTwo);
    const { queries, scanner } = scannerWithClaims([malformed, valid]);

    await expect(scanner.scanDue(scanInput)).rejects.toBeInstanceOf(ZodError);
    expect(
      queries.filter(([text]) =>
        text.includes('release_trigger_schedule_claim'),
      ),
    ).toEqual([
      [
        expect.stringContaining('release_trigger_schedule_claim'),
        [ids.triggerTwo, ids.leaseTwo],
      ],
    ]);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('preserves recurrence failure while attempting fail then later release', async () => {
    const failure = new Error('fail cleanup unavailable');
    const { queries, scanner } = scannerWithClaims(
      [
        claim(ids.triggerOne, ids.leaseOne, {
          recurrence_kind: 'cron',
          cron_expression: 'invalid',
          timezone: 'UTC',
          interval_minutes: null,
        }),
        claim(ids.triggerTwo, ids.leaseTwo),
      ],
      (statement) =>
        statement.includes('fail_trigger_schedule_claim')
          ? Promise.reject(failure)
          : Promise.resolve({ rowCount: 1, rows: [] }),
    );

    await expect(scanner.scanDue(scanInput)).rejects.toThrow(
      'Invalid schedule recurrence',
    );
    expect(
      queries
        .filter(([text]) => text.includes('trigger_schedule_claim'))
        .map(([text]) =>
          text.includes('fail_trigger_schedule_claim') ? 'fail' : 'release',
        ),
    ).toEqual(['fail', 'release']);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('stops admission between rows and releases every remaining claim', async () => {
    const reason = new Error('stop between rows');
    const controller = new AbortController();
    let releaseCount = 0;
    const { queries, scanner } = scannerWithClaims(
      [
        claim(ids.triggerOne, ids.leaseOne, {
          anchor_at: new Date('2026-01-01T00:10:00.000Z'),
          next_fire_at: new Date('2026-01-01T00:11:00.000Z'),
        }),
        claim(ids.triggerTwo, ids.leaseTwo),
      ],
      (statement) => {
        if (statement.includes('release_trigger_schedule_claim')) {
          releaseCount += 1;
          if (releaseCount === 1) controller.abort(reason);
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      },
    );

    await expect(
      scanner.scanDue({ ...scanInput, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(releaseCount).toBe(2);
    expect(
      queries
        .filter(([text]) => text.includes('release_trigger_schedule_claim'))
        .map(([, parameters]) => parameters?.[0]),
    ).toEqual([ids.triggerOne, ids.triggerTwo]);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('preserves acceptance failure when fail cleanup rejects and retires later rows', async () => {
    const primary = new Error('checkpoint failed');
    seams.workspaceTransaction.mockRejectedValueOnce(primary);
    const { queries, scanner } = scannerWithClaims(
      [
        claim(ids.triggerOne, ids.leaseOne),
        claim(ids.triggerTwo, ids.leaseTwo),
      ],
      (statement) =>
        statement.includes('fail_trigger_schedule_claim')
          ? Promise.reject(new Error('fail cleanup rejected'))
          : Promise.resolve({ rowCount: 1, rows: [] }),
    );

    await expect(scanner.scanDue(scanInput)).rejects.toBe(primary);
    expect(
      queries
        .filter(([text]) => text.includes('trigger_schedule_claim'))
        .map(([text]) =>
          text.includes('fail_trigger_schedule_claim') ? 'fail' : 'release',
        ),
    ).toEqual(['fail', 'release']);
    expect(seams.workspaceTransaction).toHaveBeenCalledOnce();
  });
});
describe('schedule misfire disposition (ADR 049)', () => {
  beforeEach(beforeEachFixture2);
  it.each([
    ['skip', '2026-01-01T01:05:00.000Z', 'accepted'],
    ['skip', '2026-01-01T01:05:00.001Z', 'skipped'],
    ['catch_up_once', '2026-01-01T01:59:59.999Z', 'accepted'],
  ] as const)(
    'decides a %s occurrence observed at %s as %s',
    async (policy, observedAt, disposition) => {
      const statements = recordAdmissionTransactions();
      const { scanner } = scannerWithClaims([hourlyClaim(policy, observedAt)]);

      await expect(scanner.scanDue(scanInput)).resolves.toMatchObject({
        claimed: 1,
        accepted: disposition === 'accepted' ? 1 : 0,
        skipped: disposition === 'skipped' ? 1 : 0,
        deferred: 0,
      });
      expect(completion(statements)).toEqual({
        scheduledAt: new Date('2026-01-01T01:00:00.000Z'),
        disposition,
        runId: disposition === 'accepted' ? runId : null,
        nextAt: new Date('2026-01-01T02:00:00.000Z'),
      });
    },
  );

  it('admits an on-time skip occurrence exactly as catch-up admits it', async () => {
    const identity = `${ids.triggerOne}:2026-01-01T01:00:00.000Z`;
    for (const policy of ['skip', 'catch_up_once'] as const) {
      recordAdmissionTransactions();
      const { scanner } = scannerWithClaims([
        hourlyClaim(policy, '2026-01-01T01:00:01.000Z'),
      ]);
      await expect(scanner.scanDue(scanInput)).resolves.toMatchObject({
        accepted: 1,
      });
    }

    const [skipInput, catchUpInput] = seams.acceptWorkflowRun.mock.calls.map(
      ([, input]: unknown[]) => input,
    );
    expect(skipInput).toEqual(catchUpInput);
    expect(skipInput).toMatchObject({
      keyHash: createHash('sha256').update(identity).digest('hex'),
      scope: `schedule:${ids.triggerOne}`,
      triggerType: 'schedule',
      runInput: { scheduledAt: '2026-01-01T01:00:00.000Z' },
    });
  });

  it.each([
    // 02:30 does not exist on 10 March 2030 in New York: the occurrence is
    // the first valid instant after the gap, and lateness counts from there.
    [
      '30 2 * * *',
      '2030-03-10T07:05:00.000Z',
      '2030-03-10T07:00:00.000Z',
      'accepted',
    ],
    [
      '30 2 * * *',
      '2030-03-10T07:05:00.001Z',
      '2030-03-10T07:00:00.000Z',
      'skipped',
    ],
    // 01:30 happens twice on 3 November 2030: the occurrence is the earlier
    // instant, so seeing the repeated wall-clock time an hour on is late.
    [
      '30 1 * * *',
      '2030-11-03T05:35:00.000Z',
      '2030-11-03T05:30:00.000Z',
      'accepted',
    ],
    [
      '30 1 * * *',
      '2030-11-03T06:31:00.000Z',
      '2030-11-03T05:30:00.000Z',
      'skipped',
    ],
  ] as const)(
    'measures %s in New York observed at %s from its DST-resolved instant',
    async (expression, observedAt, scheduledAt, disposition) => {
      const statements = recordAdmissionTransactions();
      const { scanner } = scannerWithClaims([
        claim(ids.triggerOne, ids.leaseOne, {
          recurrence_kind: 'cron',
          cron_expression: expression,
          timezone: 'America/New_York',
          interval_minutes: null,
          misfire_policy: 'skip',
          anchor_at: new Date(
            expression === '30 2 * * *'
              ? '2030-03-09T12:00:00.000Z'
              : '2030-11-02T12:00:00.000Z',
          ),
          next_fire_at: new Date(scheduledAt),
          observed_at: new Date(observedAt),
        }),
      ]);

      await scanner.scanDue(scanInput);
      expect(completion(statements)).toMatchObject({
        scheduledAt: new Date(scheduledAt),
        disposition,
      });
    },
  );
});
