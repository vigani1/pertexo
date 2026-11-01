import { afterAll, beforeAll, expect, it } from 'vitest';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';
const schedule = createScheduleTriggerTestEnvironment({ scannerCount: 2 });
beforeAll(() => schedule.initialize(), 60_000);
afterAll(schedule.close);
const scan = (second = false) =>
  (second ? schedule.scannerTwo : schedule.scannerOne).scanDue({
    leaseOwner: second ? 'skip-scanner-two' : 'skip-scanner-one',
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory: schedule.checkpointFactory,
  });
async function makeDue() {
  await schedule.ownerQuery(
    `update app.trigger_schedules set last_fire_at=null,anchor_at=statement_timestamp()-interval '2 minutes',next_fire_at=statement_timestamp()-interval '1 minute' where trigger_id=$1`,
    [schedule.triggerId],
  );
}
it('records concurrency skips separately from misfires, advances across scanners and accepts again after release', async () => {
  const { workspaceId, workflowId, triggerId, actorId } = schedule;
  await schedule.ownerQuery(
    `update app.trigger_schedules set status='disabled' where trigger_id<>$1`,
    [triggerId],
  );
  expect(await scan()).toMatchObject({ accepted: 1, skipped: 0 });
  await schedule.ownerQuery(
    `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
    [workspaceId, workflowId],
  );
  await makeDue();
  expect(await scan(true)).toMatchObject({ accepted: 0, skipped: 1 });
  const history = await schedule.schedules.listOccurrences({
    workspaceId,
    workflowId,
    triggerId,
    actorId,
  });
  expect(history.items[0]).toMatchObject({
    outcome: 'skipped',
    skipReason: 'concurrency_limit',
    runId: null,
  });
  expect(await scan()).toMatchObject({ claimed: 0, accepted: 0, skipped: 0 });
  const counts = () =>
    schedule.ownerQuery(
      `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,(select count(*)::int from app.usage_events where category='trigger.skipped' and resource_id=$1) skips`,
      [workflowId],
    );
  expect((await counts()).rows).toEqual([{ runs: 1, skips: 1 }]);
  await schedule.ownerQuery(
    `update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where workflow_id=$1 and status='queued'`,
    [workflowId],
  );
  await makeDue();
  expect(await scan(true)).toMatchObject({ accepted: 1, skipped: 0 });
  expect((await counts()).rows).toEqual([{ runs: 2, skips: 1 }]);
});
