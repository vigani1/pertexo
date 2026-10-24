import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { PublishedWorkflow } from '../../runs/queries/execution/published.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.js';
import type { AcceptVerifiedWebhookDeliveryInput } from './repository.js';
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
    dedupeKind,
  }: Readonly<{
    runInput: unknown;
    prepared: PreparedEventCoordination;
    projection: PublishedWorkflow;
    deliveryId: string;
    dedupeKind: 'keyed' | 'fingerprint';
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
  await insertWebhookDelivery(transaction, verification, {
    id: deliveryId,
    outcome: coordinatedDeliveryOutcome(result),
    signatureCheck: 'verified',
    replayCheck: 'new',
    bodyBytes: input.bodyBytes,
    dedupeKind,
    coordinationEventId: deliveryId,
    ...(runId === undefined ? {} : { runId }),
  });
  await transaction.db.execute(
    sql`update app.webhook_trigger_replay_records set coordination_event_id=${deliveryId},workflow_run_id=${runId ?? null},skip_reason=${'skipped' in result ? 'concurrency_limit' : null} where workspace_id=${transaction.workspaceId} and delivery_id=${deliveryId}`,
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
