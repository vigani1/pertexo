import type { PoolClient } from 'pg';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  type CommitAdvancePlanResult,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';
import {
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  deferCoordinatorForActiveCapacity,
  validateAuthoritativeAdvanceDelivery,
} from './coordinator-run-store-delivery.js';
import {
  mapEvent,
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
  record,
  validatePersistedFactBatch,
} from './coordinator-run-store-observations.js';
import {
  allowedRunTransitions,
  type ParsedTransitionPlan,
  validateStatusTransitions,
  validateTransitionDelta,
} from './coordinator-run-store-plan.js';
import {
  parsePersistedWorkflowCheckpoint,
  type PersistedWorkflowCheckpoint,
} from '../compatibility/persisted-workflow-checkpoint.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

export type CoordinatorCommitRow = Readonly<{
  revision: number;
  scheduler_state: unknown;
  last_transition_fingerprint: string | null;
  workflow_version_id: string;
  status: string;
  cancel_requested_at: Date | null;
  deadline_expired: boolean;
  workflow_id: string;
  trigger_type: string;
  started_at: Date | null;
  created_at: Date;
  failure_notification_policy_version: number | null;
  failure_notification_destination_id: string | null;
  failure_notification_destination_config_version: number | null;
  failure_notification_side_effect_class: string | null;
  execution_entitlement_version: number;
  input_ref: unknown;
}>;

export type PendingCoordinatorFailure = Readonly<{
  attempt_id: string;
  attempt_number: number;
  executor_error_kind: string;
  executor_failure_kind: string;
  executor_possibly_dispatched: boolean;
  invocation_key: string;
  safe_error_code: string;
}>;

export type CoordinatorCommitState =
  | Readonly<{ kind: 'outcome'; result: CommitAdvancePlanResult }>
  | Readonly<{
      kind: 'ready';
      row: CoordinatorCommitRow;
      currentCheckpoint: PersistedWorkflowCheckpoint;
      pendingFailures: readonly PendingCoordinatorFailure[];
      authoritativeCancellation: boolean;
    }>;

function outcome(result: CommitAdvancePlanResult): CoordinatorCommitState {
  return Object.freeze({ kind: 'outcome', result });
}

export async function lockCoordinatorCommitState(
  client: PoolClient,
  input: Readonly<{
    checkpointJson: string;
    delivery: CoordinatorAdvanceDelivery;
    plan: ParsedTransitionPlan;
    planFingerprint: string;
    runId: string;
    traceparent?: string;
    workflowVersionId: string;
    workspaceId: string;
  }>,
): Promise<CoordinatorCommitState> {
  const {
    checkpointJson,
    delivery,
    plan,
    planFingerprint,
    runId,
    traceparent,
    workflowVersionId,
    workspaceId,
  } = input;
  await validateAuthoritativeAdvanceDelivery(
    client,
    workspaceId,
    runId,
    delivery,
  );
  const locked = await client.query<CoordinatorCommitRow>(
    `select checkpoint.revision, checkpoint.scheduler_state,
            checkpoint.last_transition_fingerprint,
            checkpoint.workflow_version_id, run.status,
            run.cancel_requested_at,run.workflow_id,run.trigger_type,
            run.started_at,run.created_at,
            run.failure_notification_policy_version,
            run.failure_notification_destination_id,
            run.failure_notification_destination_config_version,
            run.failure_notification_side_effect_class,
            run.execution_entitlement_version,run.input_ref,
            run.deadline_at is not null
              and run.deadline_at <= clock_timestamp() as deadline_expired
       from app.workflow_runs run
       join app.run_checkpoints checkpoint
         on checkpoint.workspace_id = run.workspace_id
        and checkpoint.workflow_run_id = run.id
       where run.workspace_id = $1 and run.id = $2
       for update of run, checkpoint`,
    [workspaceId, runId],
  );
  const row = locked.rows[0];
  if (row === undefined) return outcome({ kind: 'not_found' });
  if (row.workflow_version_id !== workflowVersionId)
    throw new CoordinatorPlanInvalidError();
  if (row.revision !== plan.expectedRevision) {
    if (
      row.revision === plan.expectedRevision + 1 &&
      row.last_transition_fingerprint === planFingerprint &&
      serializeStoredExecutionJsonValue(row.scheduler_state) === checkpointJson
    ) {
      const receipt = await claimCoordinatorReceipt(
        client,
        workspaceId,
        delivery,
      );
      if (receipt === 'new')
        await completeCoordinatorReceipt(client, workspaceId, delivery);
      return outcome({ kind: 'already_committed', revision: row.revision });
    }
    return outcome({ kind: 'stale', revision: row.revision });
  }

  let currentCheckpoint: PersistedWorkflowCheckpoint;
  try {
    currentCheckpoint = parsePersistedWorkflowCheckpoint(row.scheduler_state);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  if (
    currentCheckpoint.workflowVersionId !== workflowVersionId ||
    currentCheckpoint.revision !== row.revision ||
    currentCheckpoint.runStatus !== row.status ||
    currentCheckpoint.nextEventSequence !== plan.expectedNextEventSequence
  )
    throw new CoordinatorRunStateCorruptError();
  validateTransitionDelta(currentCheckpoint, plan);
  if (
    !allowedRunTransitions[currentCheckpoint.runStatus]?.has(
      plan.checkpoint.runStatus,
    )
  )
    throw new CoordinatorPlanInvalidError();

  const highWaterResult = await client.query<{ high_water: number }>(
    `select coalesce(max(sequence), 0)::int as high_water
       from app.run_events
       where workspace_id = $1 and workflow_run_id = $2`,
    [workspaceId, runId],
  );
  if (highWaterResult.rows[0]?.high_water !== plan.consumedThroughEventSequence)
    return outcome({ kind: 'stale', revision: row.revision });

  const expectedPersistedFactCount = Math.max(
    0,
    plan.consumedThroughEventSequence - currentCheckpoint.nextEventSequence + 1,
  );
  const factCapacity = await persistedFactCapacity(
    client,
    workspaceId,
    runId,
    currentCheckpoint.nextEventSequence,
    plan.consumedThroughEventSequence,
  );
  if (factCapacity.count !== expectedPersistedFactCount)
    return outcome({ kind: 'stale', revision: row.revision });
  if (factCapacity.count > maximumPersistedFacts)
    throw new CoordinatorRunStateCorruptError();
  const persistedFacts = await readPersistedFacts(client, {
    count: factCapacity.count,
    firstSequence: currentCheckpoint.nextEventSequence,
    lastSequence: plan.consumedThroughEventSequence,
    runId,
    workspaceId,
  });
  if (persistedFacts.length !== expectedPersistedFactCount)
    return outcome({ kind: 'stale', revision: row.revision });
  validatePersistedFactBatch(persistedFacts);

  const pendingFailures = await client.query<PendingCoordinatorFailure>(
    `select attempt.id attempt_id,attempt.attempt_number,
            attempt.executor_failure_kind,attempt.executor_error_kind,
            attempt.executor_possibly_dispatched,attempt.safe_error_code,
            node.invocation_key
       from app.node_attempts attempt
       join app.node_runs node
         on node.workspace_id=attempt.workspace_id
        and node.id=attempt.node_run_id
       where attempt.workspace_id=$1 and node.workflow_run_id=$2
         and node.current_attempt_id=attempt.id
         and node.status='running' and attempt.status='failed'
         and attempt.retry_decision='pending'
       order by node.invocation_key,attempt.id
       for update of node,attempt`,
    [workspaceId, runId],
  );
  validateStatusTransitions(currentCheckpoint, plan, [
    ...persistedFacts.map((fact) => ({
      invocationKey: fact.invocation_key,
      observation: record(mapEvent(fact)),
      type: fact.type,
    })),
    ...pendingFailures.rows.map((failure) => ({
      invocationKey: failure.invocation_key,
      type: 'attempt_failure',
      observation: record({
        kind: 'attempt_failure',
        attemptId: failure.attempt_id,
        attemptNumber: failure.attempt_number,
        failureKind: failure.executor_failure_kind,
        errorKind: failure.executor_error_kind,
        possiblyDispatched: failure.executor_possibly_dispatched,
        safeErrorCode: failure.safe_error_code,
      }),
    })),
  ]);
  if (
    (currentCheckpoint.cancelRequested && row.cancel_requested_at === null) ||
    (currentCheckpoint.deadlineExpired && !row.deadline_expired)
  )
    throw new CoordinatorRunStateCorruptError();
  const authoritativeCancellation =
    currentCheckpoint.cancelRequested || row.cancel_requested_at !== null;
  const authoritativeDeadline =
    currentCheckpoint.deadlineExpired || row.deadline_expired;
  if (
    plan.checkpoint.cancelRequested !== authoritativeCancellation ||
    plan.checkpoint.deadlineExpired !== authoritativeDeadline
  ) {
    if (
      (!plan.checkpoint.cancelRequested && authoritativeCancellation) ||
      (!plan.checkpoint.deadlineExpired && authoritativeDeadline)
    )
      return outcome({ kind: 'stale', revision: row.revision });
    throw new CoordinatorPlanInvalidError();
  }
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
    if (deferred !== undefined) return outcome(deferred);
  }
  return Object.freeze({
    kind: 'ready',
    row,
    currentCheckpoint,
    pendingFailures: pendingFailures.rows,
    authoritativeCancellation,
  });
}
