import { randomUUID } from 'node:crypto';

import { createScheduleTriggerTestEnvironment } from '../../../support/schedule-triggers.js';

export const schedule = createScheduleTriggerTestEnvironment();

export const {
  actorId,
  checkpointFactory,
  ownerQuery,
  skipTriggerId,
  triggerId,
  workflowId,
  workspaceId,
} = schedule;

export const quotaTriggerId = randomUUID();

export async function beforeAllFixture1() {
  await schedule.initialize();
  const interruptedClaim = await schedule.worker.query<{ trigger_id: string }>(
    'select * from app.claim_due_trigger_schedules($1,1,1)',
    ['initial-interrupted-scanner'],
  );
  if (interruptedClaim.rows[0]?.trigger_id !== triggerId) {
    throw new Error('Expected schedule prerequisite claim was not established');
  }
  const skippedScan = await schedule.scannerOne.scanDue({
    leaseOwner: 'initial-skip-scanner',
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });
  if (skippedScan.skipped !== 1) {
    throw new Error('Skipped schedule prerequisite was not established');
  }
  await ownerQuery(
    `update app.trigger_schedules
        set lease_acquired_at=clock_timestamp()-interval '2 seconds',
            lease_expires_at=clock_timestamp()-interval '1 second'
      where trigger_id=$1`,
    [triggerId],
  );
  const acceptedScan = await schedule.scannerOne.scanDue({
    leaseOwner: 'initial-acceptance-scanner',
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });
  if (acceptedScan.accepted !== 1) {
    throw new Error('Accepted schedule prerequisite was not established');
  }
}
