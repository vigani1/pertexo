import type { InitialCheckpointFactory } from '../../../src/runs/commands/initial-checkpoint.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import { initialCheckpointFactory } from '../../../src/runs/commands/create-initial-checkpoint.js';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';

const schedule = createScheduleTriggerTestEnvironment();
const { ownerQuery, triggerId, skipTriggerId, workflowId } = schedule;
beforeAll(async () => {
  await schedule.initialize();
  await ownerQuery(
    "update app.trigger_schedules set status='disabled' where trigger_id=$1",
    [skipTriggerId],
  );
}, 60_000);
afterAll(schedule.close);

const scan = (
  checkpointFactory: InitialCheckpointFactory = schedule.checkpointFactory,
) =>
  schedule.scannerOne.scanDue({
    leaseOwner: 'health',
    limit: 10,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });

async function expectHealth(code: string) {
  expect(
    (
      await ownerQuery(
        `select schedule.health_status,schedule.last_error_code,trigger.last_error_code trigger_error,
    schedule.lease_token from app.trigger_schedules schedule join app.workflow_triggers trigger on trigger.id=schedule.trigger_id where schedule.trigger_id=$1`,
        [triggerId],
      )
    ).rows,
  ).toEqual([
    {
      health_status: 'unhealthy',
      last_error_code: code,
      trigger_error: code,
      lease_token: null,
    },
  ]);
  expect(
    (
      await ownerQuery(
        'select id from app.trigger_schedule_occurrences where trigger_id=$1',
        [triggerId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await ownerQuery(
        'select id from app.workflow_runs where workflow_id=$1',
        [workflowId],
      )
    ).rows,
  ).toEqual([]);
}

describe('schedule failures that need repair', () => {
  it('reports an incompatible retained executable separately from a temporary scan failure', async () => {
    const factory = initialCheckpointFactory({
      catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
    });
    await expect(scan(factory)).rejects.toBeDefined();
    await expectHealth('schedule.execution_incompatible');
  });
  it('reports an invalid stored recurrence without copying its text into health', async () => {
    await ownerQuery(
      `update app.trigger_schedules set recurrence_kind='cron',cron_expression='private invalid recurrence',
      timezone='Europe/London',interval_minutes=null,admission_deferred_until=null where trigger_id=$1`,
      [triggerId],
    );
    await expect(scan()).rejects.toThrow('Invalid schedule recurrence');
    await expectHealth('schedule.recurrence_invalid');
  });
});
