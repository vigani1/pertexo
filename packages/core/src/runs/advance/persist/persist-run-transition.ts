import { recordInboxFailureDay } from './inbox-failure-day.repository.js';
import { assertRunStartDeadline } from '../queued-run-admission.repository.js';
import { releaseSlotDuringTimedWait } from '../timed-wait-slot.repository.js';
import { isTestRun } from '../../../shared/run-retention.repository.js';
import { wakeErrorWorkflowsForCapacity } from '../../error-workflows/queue-wait.repository.js';
import { synchronizeHumanWait } from '../../pending-tasks/lifecycle/synchronize-human-wait.js';
import { persistErrorWorkflowIntent } from '../../error-workflows/persist-intent.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../coordinator-state.errors.js';
import type { CoordinatorCommitRow } from '../load/load-run.js';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { persistFailureNotificationIntent } from './failure-notification.repository.js';
import { persistWorkspaceInboxEvent } from './inbox-event.repository.js';
import { persistWorkflowTriggerOutcome } from './trigger-outcome.repository.js';
import { persistCallCompletion } from '../../calls/persist.repository.js';
import { wakeWorkflowRun } from '../../../outbox/run-advance.repository.js';
import {
  secondsSince,
  storeRunTransition,
  storeTransitionCheckpoint,
} from './run-transitions.repository.js';
import {
  continuesImmediately,
  recordsInboxFailureDay,
  scheduledOccurrence,
  transitionHasHumanWait,
  transitionMoments,
} from './run-transition.js';

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
  const stored = await storeTransitionCheckpoint(client, input);
  if (!stored) throw new CoordinatorRunStateCorruptError();

  const { startedAt, completedAt, runFailure } = transitionMoments(plan);
  await persistFailureDay(client, input, completedAt);
  await assertRunStartDeadline(client, {
    workspaceId,
    runId,
    currentStatus: row.status,
    nextStatus: plan.checkpoint.runStatus,
  });
  await storeRunTransition(client, {
    workspaceId,
    runId,
    plan,
    startedAt,
    completedAt,
    runFailure,
  });
  if (transitionHasHumanWait(row, plan))
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
  // Keep the engine's immediate continuation durable in the same transaction.
  if (continuesImmediately(plan))
    await wakeWorkflowRun(client, workspaceId, runId, input.traceparent);
  const scheduleDueAt = scheduledOccurrence(row, plan);
  return Object.freeze(
    scheduleDueAt === undefined
      ? {}
      : {
          scheduleToStartSeconds: await scheduleToStartSeconds(
            client,
            scheduleDueAt,
          ),
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

async function persistFailureDay(
  client: PoolClient,
  input: Parameters<typeof persistCoordinatorRunTransition>[1],
  completedAt: string | undefined,
): Promise<void> {
  const { workspaceId, row, plan } = input;
  if (recordsInboxFailureDay(row, plan, completedAt)) {
    await recordInboxFailureDay(client, {
      workspaceId,
      workflowId: row.workflow_id,
      completedAt,
    });
  }
}

async function scheduleToStartSeconds(client: PoolClient, dueAt: string) {
  const seconds = await secondsSince(client, dueAt);
  if (seconds === undefined) throw new CoordinatorRunStateCorruptError();
  return seconds;
}
