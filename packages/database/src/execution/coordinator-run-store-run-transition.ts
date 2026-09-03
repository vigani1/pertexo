import type { PoolClient } from 'pg';

import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { CoordinatorCommitRow } from './coordinator-run-store-commit-state.js';
import { canonicalTimestamp } from './coordinator-run-store-observations.js';
import {
  scheduleRunInputSchema,
  terminalRunStatuses,
  type ParsedTransitionPlan,
} from './coordinator-run-store-plan.js';
import { persistFailureNotificationIntent } from './coordinator-run-store-terminal.js';
import { parseStoredExecutionValueV1 } from './stored-execution-value.js';

function scheduledOccurrence(
  row: CoordinatorCommitRow,
  plan: ParsedTransitionPlan,
): string | undefined {
  const startedAt = plan.events.find(
    ({ name }) => name === 'run.started',
  )?.occurredAt;
  if (startedAt === undefined || row.trigger_type !== 'schedule')
    return undefined;
  const storedInput = parseStoredExecutionValueV1(row.input_ref);
  if (storedInput.kind !== 'inline')
    throw new CoordinatorRunStateCorruptError();
  const scheduleInput = scheduleRunInputSchema.safeParse(storedInput.value);
  if (!scheduleInput.success) throw new CoordinatorRunStateCorruptError();
  return canonicalTimestamp(scheduleInput.data.scheduledAt);
}

export async function persistCoordinatorRunTransition(
  client: PoolClient,
  input: Readonly<{
    authoritativeCancellation: boolean;
    checkpointJson: string;
    plan: ParsedTransitionPlan;
    planFingerprint: string;
    row: CoordinatorCommitRow;
    runId: string;
    traceparent?: string;
    workflowVersionId: string;
    workspaceId: string;
  }>,
): Promise<Readonly<{ scheduleDueAt?: string }>> {
  const {
    authoritativeCancellation,
    checkpointJson,
    plan,
    planFingerprint,
    row,
    runId,
    traceparent,
    workflowVersionId,
    workspaceId,
  } = input;
  await persistFailureNotificationIntent(client, {
    workspaceId,
    runId,
    workflowId: row.workflow_id,
    workflowVersionId,
    triggerType: row.trigger_type,
    startedAt: row.started_at,
    createdAt: row.created_at,
    policyVersion: row.failure_notification_policy_version,
    destinationId: row.failure_notification_destination_id,
    destinationConfigVersion:
      row.failure_notification_destination_config_version,
    sideEffectClass: row.failure_notification_side_effect_class,
    cancellationRequested: authoritativeCancellation,
    plan,
    ...(traceparent === undefined ? {} : { traceparent }),
  });

  const checkpointUpdate = await client.query(
    `update app.run_checkpoints
       set revision=$1, engine_version=$2, scheduler_state=$3::jsonb,
           last_transition_fingerprint=$7,
           resume_at=null, resume_lease_owner=null,
           resume_lease_token=null, resume_lease_expires_at=null,
           updated_at=clock_timestamp()
       where workspace_id=$4 and workflow_run_id=$5 and revision=$6`,
    [
      plan.checkpoint.revision,
      plan.checkpoint.engineVersion,
      checkpointJson,
      workspaceId,
      runId,
      plan.expectedRevision,
      planFingerprint,
    ],
  );
  if (checkpointUpdate.rowCount !== 1)
    throw new CoordinatorRunStateCorruptError();

  const startedAt = plan.events.find(
    ({ name }) => name === 'run.started',
  )?.occurredAt;
  const completedAt = plan.events.find(
    ({ name }) =>
      name.startsWith('run.') && terminalRunStatuses.has(name.slice(4)),
  )?.occurredAt;
  await client.query(
    `update app.workflow_runs
       set status=$1,
           started_at=coalesce(started_at,$2::timestamptz),
           completed_at=case when $3::timestamptz is null
             then completed_at else $3::timestamptz end,
           updated_at=clock_timestamp()
       where workspace_id=$4 and id=$5`,
    [
      plan.checkpoint.runStatus,
      startedAt ?? null,
      completedAt ?? null,
      workspaceId,
      runId,
    ],
  );
  const scheduleDueAt = scheduledOccurrence(row, plan);
  return Object.freeze(scheduleDueAt === undefined ? {} : { scheduleDueAt });
}
