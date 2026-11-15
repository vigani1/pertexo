import { decodeStoredValue } from '../../shared/stored-values.js';
import { lockWorkspaceExecutionCounter } from '../admission-locks.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { recordWorkflowTriggerSkip } from '../commands/acceptance/trigger-skips.repository.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  isWorkflowErrorTarget,
  workflowErrorInputSchema,
  canonicalJson,
} from '@pertexo/workflow-model';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../commands/acceptance/accept.js';
import { findPublishedWorkflow } from '../queries/execution/published.repository.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.types.js';
import { ErrorWorkflowDeliveryMismatchError } from './error-workflow.errors.js';
import type { ErrorWorkflowDeliveryInput } from './error-workflow-delivery.types.js';
import { deferErrorWorkflowForQueue } from './queue-wait.repository.js';
import {
  discardErrorWorkflowAdmission,
  errorWorkflowQueueWaitExpired,
  errorWorkflowTransaction,
  keepErrorWorkflowAdmission,
  lockErrorWorkflowIntent,
  lockErrorWorkflowTarget,
  markErrorWorkflowAccepted,
  openErrorWorkflowAdmission,
  readErrorWorkflowCandidate,
  refuseErrorWorkflow,
  type ErrorWorkflowRefusalCode,
} from './intents.repository.js';
import { errorWorkflowRefusal } from './refusal.js';

export async function acceptErrorWorkflow(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
  prepare: InitialCheckpointFactory,
): Promise<void> {
  const transaction = errorWorkflowTransaction(client, input.workspaceId);
  const selected = await lockErrorWorkflowSource(client, input);
  if (selected === undefined) return;
  const { candidate, target, row } = selected;
  if (row.outbox_event_id !== input.outboxEventId)
    throw new ErrorWorkflowDeliveryMismatchError();
  if (row.status !== 'pending') return;
  const refuse = (code: ErrorWorkflowRefusalCode) =>
    refuseErrorWorkflow(client, input, code);
  if (target?.lifecycle_status !== 'active') {
    await refuse('target_unavailable');
    return;
  }
  // Keep the capacity fence outside the savepoint: a refusal and its deferred
  // wakeup must commit before a releasing run can observe the pending intent.
  await lockWorkspaceExecutionCounter(transaction.db, input.workspaceId);
  if (
    row.queue_wait_expires_at !== null &&
    (await errorWorkflowQueueWaitExpired(client, input))
  ) {
    await refuse('queue_full');
    return;
  }
  const projection = await findPublishedWorkflow(transaction.db, {
    workspaceId: input.workspaceId,
    workflowId: candidate.target_workflow_id,
    id: candidate.target_version_id,
  }).catch(rethrowQueryFailure);
  if (projection === null) {
    await refuse('target_unavailable');
    return;
  }
  // A newer publication may have removed the trigger since Settings was saved.
  const envelope = decodeStoredValue(() =>
    z.object({ graph: z.unknown() }).parse(projection.executableJson),
  );
  if (!isWorkflowErrorTarget(envelope.graph)) {
    await refuse('invalid_target');
    return;
  }
  await openErrorWorkflowAdmission(client);
  try {
    const summary = decodeStoredValue(() =>
      workflowErrorInputSchema.parse(row.context),
    );
    const initial = prepare(projection);
    const prepared = await prepareWorkflowRunAcceptance(
      transaction,
      candidate.target_workflow_id,
    );
    const errorWorkflowAcceptanceFingerprint = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const accepted = await acceptWorkflowRun(
      transaction,
      {
        initialCheckpoint: initial.checkpoint,
        ...(initial.validateInput === undefined
          ? {}
          : { validateInput: initial.validateInput }),
        operation: 'workflow.run.accept',
        scope: `workflow-error:${input.sourceRunId}`,
        keyHash: errorWorkflowAcceptanceFingerprint(input.sourceRunId),
        requestHash: errorWorkflowAcceptanceFingerprint(
          `${input.sourceRunId}:${projection.id}:${canonicalJson(summary)}`,
        ),
        workflowId: candidate.target_workflow_id,
        workflowVersionId: projection.id,
        triggerType: 'workflow_error',
        runInput: summary,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
      },
      prepared,
    );
    await markErrorWorkflowAccepted(client, input, accepted.runId);
    await keepErrorWorkflowAdmission(client);
  } catch (error) {
    const reason = errorWorkflowRefusal(error);
    if (reason === undefined) throw error;
    await discardErrorWorkflowAdmission(client);
    if (
      reason === 'queue_full' &&
      (await deferErrorWorkflowForQueue(client, input))
    )
      return;
    if (reason === 'concurrency_limit')
      await recordWorkflowTriggerSkip(
        transaction,
        candidate.target_workflow_id,
        'workflow_error',
      );
    await refuse(reason);
  }
}

/** Candidate, then its target workflow, then the intent row: the delivery's lock order. */
async function lockErrorWorkflowSource(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
) {
  const candidate = await readErrorWorkflowCandidate(client, input);
  if (candidate === undefined) return undefined;
  const target = await lockErrorWorkflowTarget(client, {
    workspaceId: input.workspaceId,
    workflowId: candidate.target_workflow_id,
  });
  const row = await lockErrorWorkflowIntent(client, input);
  if (row === undefined) return undefined;
  return { candidate, target, row };
}
