import { assertRunStartDeadline } from '../queued-run-admission.repository.js';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { TERMINAL_RUN_STATUSES } from '../../statuses.js';
import { releaseSlotDuringTimedWait } from '../timed-wait-slot.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { workflowRuns, runCheckpoints } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionJsonValue,
} from '../../../shared/stored-execution.js';
import { isTestRun } from '../../data-policy.js';
import { wakeErrorWorkflowsForCapacity } from '../../error-workflows/queue-wait.repository.js';
import { synchronizeHumanWait } from '../../pending-tasks/lifecycle/time-capacity.repository.js';
import { persistErrorWorkflowIntent } from '../../error-workflows/produce.repository.js';
import type { PoolClient } from 'pg';

import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import type { CoordinatorCommitRow } from '../load/state.repository.js';
import { canonicalTimestamp } from '../load/fact-admission.js';
import { scheduleRunInputSchema } from '../../../triggers/schedules/schedule-run-input.schemas.js';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { persistFailureNotificationIntent } from './failure-notification.repository.js';
import { persistWorkspaceInboxEvent } from '../../../inbox/folding/events.repository.js';
import { persistWorkflowTriggerOutcome } from '../../../triggers/pause/outcomes.repository.js';
import { persistCallCompletion } from '../../calls/persist.repository.js';
import { wakeWorkflowRun } from '../../wakeups/advance.repository.js';

async function persistDerivedContinuation(
  client: PoolClient,
  input: Readonly<{
    plan: WorkflowTransitionPlan;
    runId: string;
    workspaceId: string;
    traceparent?: string;
  }>,
): Promise<void> {
  // The engine decides whether its scheduler still has immediate work. Keep
  // that wakeup durable in the same checkpoint/outbox transaction.
  const cannotContinueImmediately =
    !(input.plan.immediateContinuation ?? false) ||
    TERMINAL_RUN_STATUSES.has(input.plan.checkpoint.runStatus) ||
    input.plan.attempts.length > 0;
  if (cannotContinueImmediately) return;
  await wakeWorkflowRun(
    client,
    input.workspaceId,
    input.runId,
    input.traceparent,
  );
}

function scheduledOccurrence(
  row: CoordinatorCommitRow,
  plan: WorkflowTransitionPlan,
): string | undefined {
  const startedAt = plan.events.find(
    ({ name }) => name === 'run.started',
  )?.occurredAt;
  if (startedAt === undefined || row.trigger_type !== 'schedule')
    return undefined;
  const storedInput = decodeStoredValue(() =>
    parseStoredExecutionValue(row.input_ref),
  );
  if (storedInput.kind !== 'inline')
    throw new CoordinatorRunStateCorruptError();
  const scheduleInput = scheduleRunInputSchema.safeParse(storedInput.value);
  if (!scheduleInput.success) throw new CoordinatorRunStateCorruptError();
  return canonicalTimestamp(scheduleInput.data.scheduledAt);
}

async function secondsSince(client: PoolClient, moment: string) {
  const { rows } = await drizzle(client)
    .execute<{ seconds: number }>(
      sql`select extract(epoch from clock_timestamp()-${moment}::timestamptz)::float8 seconds`,
    )
    .catch(rethrowQueryFailure);
  const seconds = rows[0]?.seconds;
  if (seconds === undefined) throw new CoordinatorRunStateCorruptError();
  return seconds;
}

export async function persistCoordinatorRunTransition(
  client: PoolClient,
  input: Readonly<{
    authoritativeCancellation: boolean;
    hadWaitingStep: boolean;
    plan: WorkflowTransitionPlan;
    row: CoordinatorCommitRow;
    runId: string;
    traceparent?: string;
    workflowVersionId: string;
    workspaceId: string;
  }>,
): Promise<Readonly<{ scheduleToStartSeconds?: number }>> {
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
      name.startsWith('run.') && TERMINAL_RUN_STATUSES.has(name.slice(4)),
  )?.occurredAt;
  const runFailure = plan.events.find(
    ({ name }) =>
      name === 'run.failed' ||
      name === 'run.timed_out' ||
      name === 'run.outcome_unknown',
  )?.reasonCode;
  await assertRunStartDeadline(client, {
    workspaceId,
    runId,
    currentStatus: row.status,
    nextStatus: plan.checkpoint.runStatus,
  });
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
  await releaseSlotDuringTimedWait(
    client,
    { workspaceId, runId },
    { checkpoint: plan.checkpoint, row },
  );
  if (row.status === 'queued' && plan.checkpoint.runStatus !== 'queued')
    await wakeErrorWorkflowsForCapacity(client, workspaceId);
  await persistCallCompletion(client, input);
  await persistDerivedContinuation(client, input);
  const scheduleDueAt = scheduledOccurrence(row, plan);
  return Object.freeze(
    scheduleDueAt === undefined
      ? {}
      : {
          scheduleToStartSeconds: await secondsSince(client, scheduleDueAt),
        },
  );
}

async function persistRunNotices(
  client: PoolClient,
  input: Parameters<typeof persistCoordinatorRunTransition>[1],
): Promise<void> {
  const {
    authoritativeCancellation,
    hadWaitingStep,
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
      hadWaitingStep,
      plan,
    });
  }
}
