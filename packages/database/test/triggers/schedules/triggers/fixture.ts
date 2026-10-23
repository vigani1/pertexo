import { createScheduleTriggerTestEnvironment } from '../../../support/schedule-triggers.js';

export const schedule = createScheduleTriggerTestEnvironment({
  includeOperator: true,
  scannerCount: 2,
});

export const {
  actorId,
  checkpointFactory,
  notificationDestinationId,
  notificationSecretVersionId,
  ownerQuery,
  triggerId,
  versionId,
  workerQuery,
  workflowId,
  workspaceId,
} = schedule;

export let replaySourceRunId = '';

export async function beforeAllFixture1() {
  replaySourceRunId = await schedule.initialize();
}
