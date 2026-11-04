import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  publishTriggerWorkflow,
  deliverReconciliation,
  reconciliation,
  ownerQuery,
  workspaceId,
  workflowTriggerIds,
} from './webhooks/fixture.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

it('records a bounded repair cause from a malformed retained trigger configuration', async () => {
  const result = await publishTriggerWorkflow();
  const workflowId = result.created.workflowId;
  const ids = await workflowTriggerIds(workflowId);
  await ownerQuery(
    `update app.workflow_triggers set desired_config='{"kind":"private invalid configuration"}'::jsonb where id=$1`,
    [ids.scheduleId],
  );
  const error: unknown = await deliverReconciliation(
    workflowId,
    result.published.version.id,
    { eventId: result.eventId, payloadChecksum: result.eventChecksum },
  ).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  await reconciliation.recordFailure({
    workspaceId,
    workflowId,
    publishedVersionId: result.published.version.id,
    error,
  });
  expect(
    (
      await ownerQuery(
        'select health_status,last_error_code from app.workflow_triggers where id=$1',
        [ids.scheduleId],
      )
    ).rows,
  ).toEqual([
    {
      health_status: 'unhealthy',
      last_error_code: 'trigger.configuration_invalid',
    },
  ]);
});
