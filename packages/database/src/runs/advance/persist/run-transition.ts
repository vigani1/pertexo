import { isTestRun } from '../../data-policy.js';
import { wakeErrorWorkflowsForCapacity } from '../../error-workflows/queue-wait.js';
import { synchronizeHumanWait } from '../../pending-tasks/lifecycle/time-capacity.js';
import { persistErrorWorkflowIntent } from '../../error-workflows/produce.js';
import type { PoolClient } from 'pg';

import { CoordinatorRunStateCorruptError } from '../contract.js';
import type { CoordinatorCommitRow } from '../load/state.js';
import { canonicalTimestamp } from '../load/facts.js';
import {
  scheduleRunInputSchema,
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../plan.js';
import { persistFailureNotificationIntent } from './failure-notification.js';
import { persistWorkspaceInboxEvent } from '../../../inbox/folding/events.repository.js';
import { persistWorkflowTriggerOutcome } from '../../../triggers/pause/outcome-producer.js';
import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.repository.js';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionJsonValue,
} from '../../../platform/stored-execution-value.js';
import { persistCallCompletion } from '../../calls/persist.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';

async function persistDerivedContinuation(
  client: PoolClient,
  input: Readonly<{
    plan: RunTransitionPlan;
    runId: string;
    workspaceId: string;
    traceparent?: string;
  }>,
): Promise<void> {
  // The engine decides whether its scheduler still has immediate work. Keep
  // that wakeup durable in the same checkpoint/outbox transaction.
  const cannotContinueImmediately =
    !(input.plan.immediateContinuation ?? false) ||
    terminalRunStatuses.has(input.plan.checkpoint.runStatus) ||
    input.plan.attempts.length > 0;
  if (cannotContinueImmediately) return;
  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId: input.workspaceId,
    runId: input.runId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,aggregate_type,
       aggregate_id,payload,payload_checksum
     ) values ($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      input.workspaceId,
      input.runId,
      serializeStoredExecutionJsonValue(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
}

function scheduledOccurrence(
  row: CoordinatorCommitRow,
  plan: RunTransitionPlan,
): string | undefined {
  const startedAt = plan.events.find(
    ({ name }) => name === 'run.started',
  )?.occurredAt;
  if (startedAt === undefined || row.trigger_type !== 'schedule')
    return undefined;
  const storedInput = parseStoredExecutionValue(row.input_ref);
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
    plan: RunTransitionPlan;
    row: CoordinatorCommitRow;
    runId: string;
    traceparent?: string;
    workflowVersionId: string;
    workspaceId: string;
  }>,
): Promise<Readonly<{ scheduleDueAt?: string }>> {
  const { plan, row, runId, workspaceId } = input;
  await persistRunNotices(client, input);
  const checkpointUpdate = await client.query(
    `update app.run_checkpoints
       set revision=$1,  scheduler_state=$2::jsonb,
           resume_at=null, resume_lease_owner=null,
           resume_lease_token=null, resume_lease_expires_at=null,
           updated_at=clock_timestamp()
       where workspace_id=$3 and workflow_run_id=$4 and revision=$5`,
    [
      plan.checkpoint.revision,
      serializeStoredExecutionJsonValue(plan.checkpoint),
      workspaceId,
      runId,
      plan.expectedRevision,
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
  const runFailure = plan.events.find(
    ({ name }) => name === 'run.failed',
  )?.reasonCode;
  await client.query(
    `update app.workflow_runs
       set status=$1, handled_failure_count=$8,
           started_at=coalesce(started_at,$2::timestamptz),
           completed_at=case when $3::timestamptz is null
             then completed_at else $3::timestamptz end,
           output_ref=case when $6::json is null then output_ref else $6::json end,
           error_summary=coalesce($7::varchar,error_summary),
           updated_at=clock_timestamp()
       where workspace_id=$4 and id=$5`,
    [
      plan.checkpoint.runStatus,
      startedAt ?? null,
      completedAt ?? null,
      workspaceId,
      runId,
      plan.runResult === undefined
        ? null
        : JSON.stringify({ kind: 'inline', value: plan.runResult }),
      runFailure ?? null,
      plan.checkpoint.invocations.filter(
        ({ failureHandling }) => failureHandling?.disposition === 'handled',
      ).length,
    ],
  );
  const hasHumanWait =
    row.human_wait_started_at !== null ||
    row.has_unconsumed_tasks ||
    (row.has_human_child ?? false) ||
    (plan.taskIntents?.length ?? 0) > 0;
  if (hasHumanWait)
    await synchronizeHumanWait(client, workspaceId, {
      runId,
      phase: 'committed',
      alreadyDeferred: row.human_resume_deferred ?? false,
    });
  if (row.status === 'queued' && plan.checkpoint.runStatus !== 'queued')
    await wakeErrorWorkflowsForCapacity(client, workspaceId);
  await persistCallCompletion(client, input);
  const scheduleDueAt = scheduledOccurrence(row, plan);
  await persistDerivedContinuation(client, input);
  return Object.freeze(scheduleDueAt === undefined ? {} : { scheduleDueAt });
}

async function persistRunNotices(
  client: PoolClient,
  input: Parameters<typeof persistCoordinatorRunTransition>[1],
): Promise<void> {
  const {
    authoritativeCancellation,
    plan,
    row,
    runId,
    traceparent,
    workflowVersionId,
    workspaceId,
  } = input;
  if (!isTestRun(row.trigger_type)) {
    await persistFailureNotificationIntent(client, {
      workspaceId,
      runId,
      workflowId: row.workflow_id,
      workflowVersionId,
      triggerType: row.trigger_type,
      startedAt: row.started_at,
      createdAt: row.created_at,
      destinationId: row.failure_notification_destination_id,
      destinationConfigVersion:
        row.failure_notification_destination_config_version,
      sideEffectClass: row.failure_notification_side_effect_class,
      cancellationRequested: authoritativeCancellation,
      plan,
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    await persistErrorWorkflowIntent(client, {
      workspaceId,
      runId,
      workflowId: row.workflow_id,
      workflowVersionId,
      cancellationRequested: authoritativeCancellation,
      plan,
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    await persistWorkspaceInboxEvent(client, {
      workspaceId,
      workflowId: row.workflow_id,
      runId,
      cancellationRequested: authoritativeCancellation,
      plan,
    });
    await persistWorkflowTriggerOutcome(client, {
      workspaceId,
      workflowId: row.workflow_id,
      runId,
      triggerType: row.trigger_type,
      cancellationRequested: authoritativeCancellation,
      plan,
    });
  }
}
