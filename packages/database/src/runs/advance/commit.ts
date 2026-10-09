import type { PoolClient } from 'pg';
import type { WorkflowCheckpoint } from '@pertexo/workflow-engine';

import {
  CoordinatorRunStateCorruptError,
  type CoordinatorAdvanceDelivery,
  type RunAdvanceResult,
} from './contract.js';
import { persistCoordinatorExecutionTransitions } from './node-admissions.js';
import type { RunTransitionPlan } from './plan.js';
import {
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  deferCoordinatorForActiveCapacity,
} from './receipts.js';
import { persistCoordinatorRunTransition } from './run-transition.js';
import {
  persistDueReadyTransitions,
  persistLoopBarrierTransitions,
  settleRejectedForEachDeclarations,
} from './settlement.js';
import type {
  CoordinatorCommitRow,
  PendingCoordinatorFailure,
} from './state.js';

/** Saves the engine's transition for a run locked by `loadRunForAdvance`. */
export async function saveRunTransition(
  client: PoolClient,
  input: Readonly<{
    delivery: CoordinatorAdvanceDelivery;
    pendingFailures: readonly PendingCoordinatorFailure[];
    plan: RunTransitionPlan;
    previous: WorkflowCheckpoint;
    row: CoordinatorCommitRow;
    runId: string;
    traceparent?: string;
    workspaceId: string;
  }>,
): Promise<RunAdvanceResult & Readonly<{ scheduleDueAt?: string }>> {
  const { delivery, plan, previous, row, runId, traceparent, workspaceId } =
    input;
  if (
    (await claimCoordinatorReceipt(client, workspaceId, delivery)) ===
    'duplicate'
  )
    return Object.freeze({
      kind: 'already_committed',
      revision: row.revision,
    });
  if (
    plan.expectedRevision !== row.revision ||
    plan.checkpoint.workflowVersionId !== row.workflow_version_id
  )
    throw new CoordinatorRunStateCorruptError();
  if (
    row.status === 'queued' &&
    (plan.checkpoint.runStatus === 'running' ||
      plan.checkpoint.runStatus === 'waiting')
  ) {
    const deferred = await deferCoordinatorForActiveCapacity(client, {
      workspaceId,
      runId,
      revision: row.revision,
      entitlementVersion: row.execution_entitlement_version,
      delivery,
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    if (deferred !== undefined) return deferred;
  }

  const rejectedForEachDeclarations = await settleRejectedForEachDeclarations(
    client,
    workspaceId,
    runId,
    plan,
  );
  await persistLoopBarrierTransitions(
    client,
    workspaceId,
    runId,
    previous,
    plan.checkpoint,
  );
  await persistDueReadyTransitions(
    client,
    workspaceId,
    runId,
    previous,
    plan.checkpoint,
  );
  const physical = await persistCoordinatorExecutionTransitions(client, {
    pendingFailures: input.pendingFailures,
    rejectedForEachDeclarations,
    plan,
    runId,
    ...(traceparent === undefined ? {} : { traceparent }),
    workspaceId,
  });
  const runTransition = await persistCoordinatorRunTransition(client, {
    authoritativeCancellation:
      previous.cancelRequested || row.cancel_requested_at !== null,
    plan,
    row,
    runId,
    ...(traceparent === undefined ? {} : { traceparent }),
    workflowVersionId: row.workflow_version_id,
    workspaceId,
  });
  await completeCoordinatorReceipt(client, workspaceId, delivery);
  return Object.freeze({
    kind: 'committed',
    revision: plan.checkpoint.revision,
    admittedAttempts: Object.freeze(
      plan.attempts.map(({ invocationKey }) => {
        const ids = physical.get(invocationKey);
        if (ids?.attemptId === undefined)
          throw new CoordinatorRunStateCorruptError();
        return Object.freeze({
          invocationKey,
          nodeRunId: ids.nodeRunId,
          attemptId: ids.attemptId,
        });
      }),
    ),
    ...runTransition,
  });
}
