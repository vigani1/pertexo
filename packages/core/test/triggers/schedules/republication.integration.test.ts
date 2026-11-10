import { maintenanceConfig } from '../../../../../infrastructure/testing/worker-databases.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createScheduleTriggerScanner } from '../../../src/triggers/schedules/scanner.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  actorId,
  workspaceId,
  apiConfig,
  schedules,
  ownerQuery,
  publishTriggerWorkflow,
  publishNextTriggerWorkflowVersion,
  deliverReconciliation,
  workflowTriggerIds,
  checkpointFactory,
  hash,
} from '../webhooks/webhooks.fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

async function publish(intervalMinutes: number) {
  const result = await publishTriggerWorkflow(false, {}, intervalMinutes);
  await deliverReconciliation(
    result.created.workflowId,
    result.published.version.id,
    {
      eventId: result.eventId,
      payloadChecksum: result.eventChecksum,
    },
  );
  return result.created.workflowId;
}
async function republish(workflowId: string, intervalMinutes: number) {
  const result = await publishNextTriggerWorkflowVersion(
    workflowId,
    intervalMinutes,
  );
  await deliverReconciliation(workflowId, result.published.version.id, {
    eventId: result.eventId,
    payloadChecksum: result.eventChecksum,
  });
  return (await workflowTriggerIds(workflowId)).scheduleId;
}
async function scan() {
  const scanner = createScheduleTriggerScanner(
    maintenanceConfig(apiConfig),
    apiConfig,
  );
  try {
    return await scanner.scanDue({
      leaseOwner: 'republication',
      limit: 20,
      leaseSeconds: 30,
      onTimeWindowSeconds: 300,
      checkpointFactory,
    });
  } finally {
    await scanner.close();
  }
}

describe('published schedule operational state', () => {
  it.each([15, 30])(
    'keeps a person’s disablement when republished with a %i minute interval',
    async (interval) => {
      const workflowId = await publish(15);
      const firstId = (await workflowTriggerIds(workflowId)).scheduleId;
      await schedules.setEnabled({
        workspaceId,
        actorId,
        workflowId,
        triggerId: firstId,
        enabled: false,
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      });
      const triggerId = await republish(workflowId, interval);
      const before = await schedules.list({ workspaceId, workflowId, actorId });
      expect(before.find((row) => row.id === triggerId)).toMatchObject({
        status: 'disabled',
        healthStatus: 'disabled',
      });
      await ownerQuery(
        "update app.trigger_schedules set next_fire_at=clock_timestamp()-interval '1 minute' where trigger_id=$1",
        [triggerId],
      );
      await scan();
      expect(
        (
          await ownerQuery(
            'select id from app.workflow_runs where workflow_id=$1',
            [workflowId],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await ownerQuery(
            'select trigger_id from app.trigger_schedule_occurrences where trigger_id=$1',
            [triggerId],
          )
        ).rows,
      ).toEqual([]);
    },
  );

  it.each(['0.594499 seconds', '0.594999 seconds', '0.595001 seconds'])(
    'keeps an unchanged hourly anchor and overdue occurrence through repeated publication, then fires it (clock fraction %s)',
    async (fraction) => {
      const workflowId = await publish(60);
      let triggerId = (await workflowTriggerIds(workflowId)).scheduleId;
      // Separate clock reads can cross a millisecond and put the cursor off its anchor.
      await ownerQuery(
        `with observation as materialized (
        select date_trunc('seconds',clock_timestamp())+$2::interval as at
      )
      update app.trigger_schedules set anchor_at=observation.at-interval '61 minutes',
      next_fire_at=observation.at-interval '1 minute' from observation where trigger_id=$1`,
        [triggerId, fraction],
      );
      const original = (
        await ownerQuery<{ anchor_at: Date; next_fire_at: Date }>(
          'select anchor_at,next_fire_at from app.trigger_schedules where trigger_id=$1',
          [triggerId],
        )
      ).rows[0];
      for (let publication = 0; publication < 6; publication++) {
        triggerId = await republish(workflowId, 60);
        expect(
          (
            await ownerQuery(
              'select anchor_at,next_fire_at from app.trigger_schedules where trigger_id=$1',
              [triggerId],
            )
          ).rows[0],
        ).toEqual(original);
      }
      await scan();
      expect(
        (
          await ownerQuery(
            'select scheduled_at,workflow_run_id from app.trigger_schedule_occurrences where trigger_id=$1',
            [triggerId],
          )
        ).rows,
      ).toEqual([
        {
          scheduled_at: original?.next_fire_at,
          workflow_run_id: expect.any(String) as unknown,
        },
      ]);
      expect(
        (
          await ownerQuery(
            'select trigger_type,status from app.workflow_runs where workflow_id=$1',
            [workflowId],
          )
        ).rows,
      ).toEqual([{ trigger_type: 'schedule', status: 'queued' }]);
    },
  );
});
