import { and, asc, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  workflowRuns,
  runCheckpoints,
  nodeRuns,
  nodeAttempts,
  pendingRunTasks,
} from '@pertexo/database/schema';
import { EXECUTION_SOURCE_SQL } from '../../queries/execution/source.queries.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export function lockRunForAdvance(
  client: PoolClient,
  workspaceId: string,
  runId: string,
) {
  const db = drizzle(client),
    run = alias(workflowRuns, 'run'),
    checkpoint = alias(runCheckpoints, 'checkpoint');
  const tasks = db
    .select({ one: sql`1` })
    .from(pendingRunTasks)
    .where(
      and(
        eq(pendingRunTasks.workspaceId, run.workspaceId),
        eq(pendingRunTasks.runId, run.id),
        isNull(pendingRunTasks.consumedAt),
      ),
    );
  return db
    .select({
      run: {
        revision: checkpoint.revision,
        scheduler_state: checkpoint.schedulerState,
        workflow_version_id: checkpoint.workflowVersionId,
        next_event_sequence: sql<
          number | null
        >`(${checkpoint.schedulerState}->>'nextEventSequence')::int`,
        checkpoint_deadline_expired: sql<
          boolean | null
        >`(${checkpoint.schedulerState}->>'deadlineExpired')::boolean`,
        status: run.status,
        cancel_requested_at: run.cancelRequestedAt,
        workflow_id: run.workflowId,
        trigger_type: run.triggerType,
        started_at: run.startedAt,
        created_at: run.createdAt,
        failure_notification_destination_id:
          run.failureNotificationDestinationId,
        failure_notification_destination_config_version:
          run.failureNotificationDestinationConfigVersion,
        failure_notification_side_effect_class:
          run.failureNotificationSideEffectClass,
        // Admission fills the entitlement version before a run can enter the coordinator.
        execution_entitlement_version: sql<number>`${run.executionEntitlementVersion}`,
        input_ref: run.inputRef,
        variable_set_revision: run.variableSetRevision,
        deadline_at: run.deadlineAt,
        human_wait_started_at: run.humanWaitStartedAt,
        timed_wait_started_at: run.timedWaitStartedAt,
        has_unconsumed_tasks: sql<boolean>`${exists(tasks)}`,
        deadline_expired: sql<boolean>`${run.deadlineAt} is not null and ${run.deadlineAt}<=clock_timestamp()`,
      },
      version: {
        id: EXECUTION_SOURCE_SQL.id,
        workspace_id: EXECUTION_SOURCE_SQL.workspace_id,
        workflow_id: EXECUTION_SOURCE_SQL.workflow_id,
        version_number: EXECUTION_SOURCE_SQL.version_number,
        checksum: EXECUTION_SOURCE_SQL.checksum,
        executable_json: EXECUTION_SOURCE_SQL.executable_json,
        test_dispositions: EXECUTION_SOURCE_SQL.test_dispositions,
        test_expires_at: EXECUTION_SOURCE_SQL.test_expires_at,
      },
    })
    .from(run)
    .innerJoin(
      checkpoint,
      and(
        eq(checkpoint.workspaceId, run.workspaceId),
        eq(checkpoint.workflowRunId, run.id),
        eq(checkpoint.workflowVersionId, run.workflowVersionId),
      ),
    )
    .leftJoin(
      EXECUTION_SOURCE_SQL,
      and(
        eq(EXECUTION_SOURCE_SQL.workspace_id, run.workspaceId),
        eq(EXECUTION_SOURCE_SQL.id, run.workflowVersionId),
      ),
    )
    .where(and(eq(run.workspaceId, workspaceId), eq(run.id, runId)))
    .for('no key update', { of: [run, checkpoint] })
    .catch(rethrowQueryFailure);
}

export function readPendingFailures(
  client: PoolClient,
  workspaceId: string,
  runId: string,
) {
  const node = alias(nodeRuns, 'node'),
    attempt = alias(nodeAttempts, 'attempt');
  return drizzle(client)
    .select({
      attempt_id: attempt.id,
      attempt_number: attempt.attemptNumber,
      completed_at:
        sql<Date>`coalesce(${attempt.completedAt},${attempt.updatedAt})`.mapWith(
          attempt.updatedAt,
        ),
      executor_failure_kind: attempt.executorFailureKind,
      executor_retry_after_millis: attempt.executorRetryAfterMillis,
      executor_error_kind: attempt.executorErrorKind,
      executor_possibly_dispatched: attempt.executorPossiblyDispatched,
      safe_error_code: attempt.safeErrorCode,
      invocation_key: node.invocationKey,
    })
    .from(attempt)
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, attempt.workspaceId),
        eq(node.id, attempt.nodeRunId),
      ),
    )
    .where(
      and(
        eq(attempt.workspaceId, workspaceId),
        eq(node.workflowRunId, runId),
        eq(node.currentAttemptId, attempt.id),
        eq(node.currentAttemptNumber, attempt.attemptNumber),
        eq(node.status, 'running'),
        eq(attempt.status, 'failed'),
        eq(attempt.retryDecision, 'pending'),
      ),
    )
    .orderBy(asc(node.invocationKey), asc(attempt.id))
    .for('update', { of: [node, attempt] })
    .catch(rethrowQueryFailure);
}

export function readDueInvocations(
  client: PoolClient,
  {
    workspaceId,
    runId,
    schedulerState,
  }: Readonly<{ workspaceId: string; runId: string; schedulerState: unknown }>,
) {
  const db = drizzle(client);
  const waiting = db
    .select({ key: sql<string>`invocation->>'invocationKey'` })
    .from(
      sql`jsonb_array_elements(${JSON.stringify(schedulerState)}::jsonb->'invocations') invocation`,
    )
    .where(sql`invocation->>'status'='waiting'`);
  // The due-time predicate excludes null values before the timestamp is projected.
  return db
    .select({
      invocation_key: nodeRuns.invocationKey,
      due_at:
        sql<Date>`coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt})`.mapWith(
          nodeRuns.retryDueAt,
        ),
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        eq(nodeRuns.status, 'waiting'),
        sql`${nodeRuns.controlKind} is distinct from 'human_task'`,
        sql`coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt})<=clock_timestamp()`,
        inArray(nodeRuns.invocationKey, waiting),
      ),
    )
    .orderBy(asc(nodeRuns.invocationKey))
    .catch(rethrowQueryFailure);
}
