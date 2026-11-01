import { expect, it } from 'vitest';

import { seams, ids, claim, scannerWithClaims, scanInput } from './fixture.js';
import { ZodError } from 'zod';

export function registerPerformsNoClaimWorkPre(): void {
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
}
