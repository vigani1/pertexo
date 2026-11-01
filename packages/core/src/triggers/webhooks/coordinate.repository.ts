import { webhookTriggerReplayRecords as replays } from '@pertexo/database/schema';
import { asksSenderToRetry } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { PublishedWorkflow } from '../../runs/queries/execution/contract.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.repository.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import type { AcceptVerifiedWebhookDeliveryInput } from './runtime/contract.js';
import { coordinateEvent } from '../coordination/accept.repository.js';
import type { PreparedEventCoordination } from '../coordination/contract.js';
import type { WebhookDeliveryOutcome } from './contract.js';
import { insertWebhookDelivery } from './deliveries.repository.js';
import { recordReplayResult } from './replay.repository.js';
import { openWebhookResponse } from './responses/admission.repository.js';

/** A delivery's run, whichever way it starts: the key is the delivery or event it answers. */
export function startWebhookRun(
  transaction: WorkspaceTransaction,
  input: AcceptVerifiedWebhookDeliveryInput,
  initial: ReturnType<InitialCheckpointFactory>,
  key: string,
  runInput: unknown,
) {
  const { verification } = input;
  return acceptWorkflowRun(transaction, {
    initialCheckpoint: initial.checkpoint,
    ...(initial.validateInput === undefined
      ? {}
      : { validateInput: initial.validateInput }),
    keyHash: createHash('sha256').update(key).digest('hex'),
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
  });
}

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
    (tx, eventId) => startWebhookRun(tx, input, initial, eventId, runInput),
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
  await recordReplayResult(transaction, deliveryId, {
    coordinationEventId: deliveryId,
    workflowRunId: runId ?? null,
    skipReason: 'skipped' in result ? 'concurrency_limit' : null,
  });
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
): WebhookDeliveryOutcome {
  if ('coordinated' in result) return 'coordinated';
  return 'skipped' in result ? 'skipped' : 'accepted';
}
