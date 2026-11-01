import { webhookTriggerReplayRecords as replays } from '@pertexo/database/schema';
import { asksSenderToRetry } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { PublishedWorkflow } from '../../runs/queries/execution/contract.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.repository.js';
import type { AcceptVerifiedWebhookDeliveryInput } from './runtime/contract.js';
import { coordinateEvent } from '../coordination/accept.repository.js';
import type { PreparedEventCoordination } from '../coordination/contract.js';
import { insertWebhookDelivery } from './deliveries.repository.js';
import { openWebhookResponse } from './responses/admission.repository.js';
export async function coordinateVerifiedWebhook(
  transaction: WorkspaceTransaction,
  input: AcceptVerifiedWebhookDeliveryInput,
  {
    runInput,
    prepared,
    projection,
    deliveryId,
  }: Readonly<{
    runInput: unknown;
    prepared: PreparedEventCoordination;
    projection: PublishedWorkflow;
    deliveryId: string;
  }>,
) {
  const initial = input.checkpointFactory(projection);
  const verification = input.verification;
  const result = await coordinateEvent(
    transaction,
    {
      eventId: deliveryId,
      workflowId: verification.workflowId,
      nodeId: verification.nodeId,
      source: 'webhook',
      endpointId: verification.endpointId,
      version: projection,
      prepared,
    },
    (tx, eventId) =>
      acceptWorkflowRun(tx, {
        initialCheckpoint: initial.checkpoint,
        ...(initial.validateInput === undefined
          ? {}
          : { validateInput: initial.validateInput }),
        keyHash: createHash('sha256').update(eventId).digest('hex'),
        operation: 'workflow.run.accept',
        requestHash: input.requestFingerprint,
        scope: `webhook:${verification.endpointId}`,
        triggerType: 'webhook',
        workflowId: verification.workflowId,
        workflowVersionId: verification.workflowVersionId,
        runInput,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
      }),
  );
  const runId = 'runId' in result ? result.runId : undefined;
  if ('coordinated' in result && asksSenderToRetry(result)) {
    // The refusal asks the sender to try again, so that try must be a new
    // attempt and not this answer read back from the replay record.
    await transaction.db
      .delete(replays)
      .where(
        and(
          eq(replays.workspaceId, transaction.workspaceId),
          eq(replays.deliveryId, deliveryId),
        ),
      );
  }
  await insertWebhookDelivery(transaction, verification, {
    id: deliveryId,
    outcome: coordinatedDeliveryOutcome(result),
    signatureCheck: 'verified',
    replayCheck: 'new',
    bodyBytes: input.bodyBytes,
    coordinationEventId: deliveryId,
    ...(runId === undefined ? {} : { runId }),
  });
  await transaction.db
    .update(replays)
    .set({
      coordinationEventId: deliveryId,
      workflowRunId: runId ?? null,
      skipReason: 'skipped' in result ? 'concurrency_limit' : null,
    })
    .where(
      and(
        eq(replays.workspaceId, transaction.workspaceId),
        eq(replays.deliveryId, deliveryId),
      ),
    );
  if (runId === undefined) return result;
  const seconds = await openWebhookResponse(
    transaction,
    verification.triggerId,
    runId,
  );
  return {
    ...result,
    ...(seconds === undefined ? {} : { responseWaitSeconds: seconds }),
  };
}

function coordinatedDeliveryOutcome(
  result: Awaited<ReturnType<typeof coordinateEvent>>,
): Parameters<typeof insertWebhookDelivery>[2]['outcome'] {
  if ('coordinated' in result) {
    return 'coordinated';
  }
  if ('skipped' in result) {
    return 'skipped';
  }
  return 'accepted';
}
