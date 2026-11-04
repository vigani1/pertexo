import { afterAll, beforeAll, expect, it } from 'vitest';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';
const schedule = createScheduleTriggerTestEnvironment();
const {
  workspaceId,
  actorId,
  workflowId,
  triggerId,
  skipTriggerId,
  ownerQuery,
} = schedule;
beforeAll(async () => {
  await schedule.initialize();
  await ownerQuery(
    "update app.trigger_schedules set status='disabled' where trigger_id=$1",
    [skipTriggerId],
  );
}, 60_000);
afterAll(schedule.close);

it('shows no upcoming occurrences when the same schedule standing prevents admission, including a suspended workspace', async () => {
  const input = { workspaceId, actorId, workflowId, triggerId, count: 3 };
  expect((await schedule.schedules.nextFireTimes(input)).items).toHaveLength(3);
  for (const [close, restore, parameters] of [
    [
      "update app.workspaces set status='suspended' where id=$1",
      "update app.workspaces set status='active' where id=$1",
      [workspaceId],
    ],
    [
      "update app.trigger_schedules set status='disabled' where trigger_id=$1",
      "update app.trigger_schedules set status='enabled' where trigger_id=$1",
      [triggerId],
    ],
    [
      "update app.workflow_triggers set status='disabled' where id=$1",
      "update app.workflow_triggers set status='active' where id=$1",
      [triggerId],
    ],
    [
      "update app.workflows set lifecycle_status='archived' where id=$1",
      "update app.workflows set lifecycle_status='active' where id=$1",
      [workflowId],
    ],
    [
      "update app.workflows set activation_status='inactive' where id=$1",
      "update app.workflows set activation_status='active' where id=$1",
      [workflowId],
    ],
  ] as const) {
    await ownerQuery(close, [...parameters]);
    try {
      expect((await schedule.schedules.nextFireTimes(input)).items).toEqual([]);
      expect(
        (
          await schedule.scannerOne.scanDue({
            leaseOwner: 'standing',
            limit: 10,
            leaseSeconds: 30,
            onTimeWindowSeconds: 300,
            checkpointFactory: schedule.checkpointFactory,
          })
        ).accepted,
      ).toBe(0);
      expect(
        (
          await ownerQuery(
            'select id from app.workflow_runs where workflow_id=$1',
            [workflowId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await ownerQuery(restore, [...parameters]);
    }
  }
});
