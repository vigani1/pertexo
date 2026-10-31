import { releaseSlotDuringTimedWait } from '../timed-wait-slot.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  workflowRuns,
  runCheckpoints,
} from '../../../schema/runs/execution.js';
import { outboxEvents } from '../../../schema/transport.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { isTestRun } from '../../data-policy.js';
import { wakeErrorWorkflowsForCapacity } from '../../error-workflows/queue-wait.repository.js';
import { synchronizeHumanWait } from '../../pending-tasks/lifecycle/time-capacity.queries.js';
import { persistErrorWorkflowIntent } from '../../error-workflows/produce.repository.js';
import type { PoolClient } from 'pg';

import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import type { CoordinatorCommitRow } from '../load/state.queries.js';
import { canonicalTimestamp } from '../load/fact-admission.js';
import {
  scheduleRunInputSchema,
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../plan.js';
import { persistFailureNotificationIntent } from './failure-notification.repository.js';
import { persistWorkspaceInboxEvent } from '../../../inbox/folding/events.repository.js';
import { persistWorkflowTriggerOutcome } from '../../../triggers/pause/outcomes.repository.js';
import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.repository.js';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionJsonValue,
} from '../../../platform/stored-execution-value.js';
import { persistCallCompletion } from '../../calls/persist.repository.js';
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
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: input.runId,
      payload: sql`${serializeStoredExecutionJsonValue(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
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
  const checkpointUpdate = await drizzle(client)
    .update(runCheckpoints)
    .set({
      revision: plan.checkpoint.revision,
      schedulerState: sql`${serializeStoredExecutionJsonValue(plan.checkpoint)}::jsonb`,
      resumeAt: null,
      resumeLeaseOwner: null,
      resumeLeaseToken: null,
      resumeLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(runCheckpoints.workspaceId, workspaceId),
        eq(runCheckpoints.workflowRunId, runId),
        eq(runCheckpoints.revision, plan.expectedRevision),
      ),
    )
    .catch(rethrowQueryFailure);
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
  await drizzle(client)
    .update(workflowRuns)
    .set({
      status: plan.checkpoint.runStatus,
      handledFailureCount: plan.checkpoint.invocations.filter(
        ({ failureHandling }) => failureHandling?.disposition === 'handled',
      ).length,
      startedAt: sql`coalesce(${workflowRuns.startedAt},${startedAt ?? null}::timestamptz)`,
      completedAt:
        completedAt === undefined
          ? undefined
          : sql`${completedAt}::timestamptz`,
      outputRef:
        plan.runResult === undefined
          ? undefined
          : sql`${JSON.stringify({ kind: 'inline', value: plan.runResult })}::json`,
      errorSummary: sql`coalesce(${runFailure ?? null}::varchar,${workflowRuns.errorSummary})`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .catch(rethrowQueryFailure);
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
  // Read from the plan first: the full check is too costly for a run with no timer,
  // such as a large loop of Calls advancing many times.
  if (
    plan.checkpoint.runStatus === 'waiting' &&
    row.timed_wait_started_at === null &&
    plan.checkpoint.invocations.some(
      ({ status, waitKind }) =>
        status === 'waiting' && waitKind === 'node_wait',
    )
  )
    await releaseSlotDuringTimedWait(client, { workspaceId, runId });
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
