import { afterAll, beforeAll, expect, it } from 'vitest';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';
const schedule = createScheduleTriggerTestEnvironment();
beforeAll(schedule.initialize, 60_000);
afterAll(schedule.close);

it('writes no lease, occurrence or run when already cancelled, and leaves the due schedule available to another worker', async () => {
  const state = async () =>
    (
      await schedule.ownerQuery(
        'select trigger_id,lease_token,next_fire_at,last_fire_at from app.trigger_schedules order by trigger_id',
      )
    ).rows;
  const before = await state();
  const stop = new AbortController();
  const reason = new Error('Stopped before scanning');
  stop.abort(reason);
  const input = {
    leaseOwner: 'cancelled',
    limit: 10,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory: schedule.checkpointFactory,
  };
  await expect(
    schedule.scannerOne.scanDue({ ...input, signal: stop.signal }),
  ).rejects.toBe(reason);
  expect(await state()).toEqual(before);
  expect(
    (
      await schedule.ownerQuery(
        'select id from app.trigger_schedule_occurrences',
      )
    ).rows,
  ).toEqual([]);
  expect(
    (await schedule.ownerQuery('select id from app.workflow_runs')).rows,
  ).toEqual([]);
  expect(
    (await schedule.scannerOne.scanDue({ ...input, leaseOwner: 'replacement' }))
      .accepted,
  ).toBe(1);
});
