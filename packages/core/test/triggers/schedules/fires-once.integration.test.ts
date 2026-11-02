import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ScheduleClaimLostError } from '../../../src/triggers/schedules/errors.js';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';

const schedule = createScheduleTriggerTestEnvironment({ scannerCount: 2 });
const { checkpointFactory, ownerQuery, skipTriggerId, triggerId, workflowId } =
  schedule;
const workspaceId = schedule.workspaceId;

beforeAll(async () => {
  await schedule.initialize();
  await ownerQuery(
    `update app.trigger_schedules set next_fire_at=clock_timestamp()+interval '1 hour'
      where trigger_id=$1`,
    [skipTriggerId],
  );
}, 60_000);
afterAll(schedule.close);

const scanner = (at: number) =>
  (at % 2 === 0 ? schedule.scannerOne : schedule.scannerTwo).scanDue({
    leaseOwner: `worker-${String(at)}`,
    limit: 10,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });

/** Anchored here, so each call is its own occurrence and not the same interval's slot. */
const makeDue = () =>
  ownerQuery(
    `update app.trigger_schedules
        set last_fire_at=null,
            anchor_at=date_trunc('milliseconds',now())-interval '61 seconds',
            next_fire_at=date_trunc('milliseconds',now())-interval '1 second',
            admission_deferred_until=null,lease_owner=null,lease_token=null,
            lease_acquired_at=null,lease_expires_at=null
      where trigger_id=$1`,
    [triggerId],
  );

const scheduleRuns = async () =>
  (
    await ownerQuery<{ runs: number }>(
      `select count(*)::int runs from app.workflow_runs
        where workflow_id=$1 and trigger_type='schedule'`,
      [workflowId],
    )
  ).rows[0]?.runs ?? 0;

const occurrences = async () =>
  (
    await ownerQuery<{ scheduled_at: Date; run_id: string | null }>(
      `select scheduled_at,workflow_run_id run_id from app.trigger_schedule_occurrences
        where trigger_id=$1 order by scheduled_at`,
      [triggerId],
    )
  ).rows;

/** A claim that turns out closed is reported lost, and that's the only failure allowed. */
async function scanWithoutFiring() {
  for (const outcome of await Promise.allSettled([scanner(0), scanner(1)]))
    if (outcome.status === 'rejected')
      expect(outcome.reason).toBeInstanceOf(ScheduleClaimLostError);
    else expect(outcome.value.accepted).toBe(0);
}

describe('a schedule firing', () => {
  beforeEach(() =>
    ownerQuery(
      `update app.workflows set lifecycle_status='active',trigger_pause_state='none',
         trigger_paused_at=null,trigger_pause_reason=null,trigger_pause_failures=null,
         trigger_pause_last_run_id=null where id=$1`,
      [workflowId],
    ),
  );

  it('fires once per occurrence with several workers racing, round after round', async () => {
    const runsBefore = await scheduleRuns();
    const occurrencesBefore = (await occurrences()).length;
    const rounds = 5;
    for (let round = 0; round < rounds; round += 1) {
      await makeDue();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, at) => scanner(at)),
      );
      expect(results.reduce((sum, { accepted }) => sum + accepted, 0)).toBe(1);
      expect(results.reduce((sum, { claimed }) => sum + claimed, 0)).toBe(1);
    }
    expect((await scheduleRuns()) - runsBefore).toBe(rounds);
    const fired = (await occurrences()).slice(occurrencesBefore);
    expect(fired).toHaveLength(rounds);
    expect(new Set(fired.map(({ run_id }) => run_id)).size).toBe(rounds);
    expect(
      new Set(fired.map(({ scheduled_at }) => scheduled_at.toISOString())).size,
    ).toBe(rounds);
  }, 60_000);

  it('does not fire the same occurrence again when a worker crashes and another picks it up', async () => {
    await makeDue();
    const { rows } = await ownerQuery<{ next_fire_at: Date }>(
      'select next_fire_at from app.trigger_schedules where trigger_id=$1',
      [triggerId],
    );
    const due = rows[0]?.next_fire_at;
    const runsBefore = await scheduleRuns();
    await scanner(0);
    expect(await scheduleRuns()).toBe(runsBefore + 1);
    // As if the first worker died after admitting but before moving the schedule on.
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,next_fire_at=$2,lease_owner=null,lease_token=null,
         lease_acquired_at=null,lease_expires_at=null where trigger_id=$1`,
      [triggerId, due],
    );
    await Promise.all([scanner(1), scanner(2)]);
    expect(await scheduleRuns()).toBe(runsBefore + 1);
  }, 30_000);

  it('does not fire for an archived workflow, even before reconciliation has caught up', async () => {
    await makeDue();
    await ownerQuery(
      "update app.workflows set lifecycle_status='archived' where id=$1",
      [workflowId],
    );
    const runsBefore = await scheduleRuns();
    await scanWithoutFiring();
    expect(await scheduleRuns()).toBe(runsBefore);
  }, 30_000);

  it('does not fire for a suspended workspace', async () => {
    await makeDue();
    await ownerQuery(
      `update app.workspaces set status='suspended' where id=$1`,
      [workspaceId],
    );
    try {
      const runsBefore = await scheduleRuns();
      await scanWithoutFiring();
      expect(await scheduleRuns()).toBe(runsBefore);
    } finally {
      await ownerQuery(
        `update app.workspaces set status='active' where id=$1`,
        [workspaceId],
      );
    }
  }, 30_000);
});
