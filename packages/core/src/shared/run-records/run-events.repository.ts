import { runEvents, workflowRuns } from '@pertexo/database/schema';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ExecutionStateConflictError } from './execution-state.errors.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

// A run's event log: runs, attempts and the operator append to it.

/** A run event's payload, checked before it is stored. */
const RUN_EVENT_PAYLOAD_MAX_BYTES = 4096;

/** A run's first event, `run.queued`; every later event follows it. */
export const QUEUED_EVENT_SEQUENCE = 1;

export const RUN_EVENT_TYPE = {
  queued: 'run.queued',
  started: 'run.started',
  waiting: 'run.waiting',
  cancelRequested: 'run.cancel_requested',
  succeeded: 'run.succeeded',
  failed: 'run.failed',
  canceled: 'run.canceled',
  timedOut: 'run.timed_out',
  outcomeUnknown: 'run.outcome_unknown',
  nodeReady: 'node.ready',
  nodeStarted: 'node.started',
  nodeProgress: 'node.progress',
  nodeWaiting: 'node.waiting',
  nodeRetryScheduled: 'node.retry_scheduled',
  nodeSucceeded: 'node.succeeded',
  nodeFailed: 'node.failed',
  nodeFailureRouted: 'node.failure_routed',
  nodeFailureHandled: 'node.failure_handled',
  nodeSkipped: 'node.skipped',
  nodeCanceled: 'node.canceled',
  nodeTimedOut: 'node.timed_out',
  nodeOutcomeUnknown: 'node.outcome_unknown',
} as const;

export type RunEventType = (typeof RUN_EVENT_TYPE)[keyof typeof RUN_EVENT_TYPE];

interface RunEvent {
  type: RunEventType;
  payload: unknown;
}

async function lockRunForEvent(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<void> {
  const rows = await transaction.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .for('update');
  if (rows[0] === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
}

export async function appendLockedRunEvent(
  transaction: WorkspaceTransaction,
  runId: string,
  event: RunEvent,
): Promise<number> {
  const serializedPayload = serializeRunEventPayload(event.payload);

  const next = transaction.db
    .select({
      workspaceId: sql<string>`${transaction.workspaceId}::uuid`.as(
        'workspace_id',
      ),
      workflowRunId: sql<string>`${runId}::uuid`.as('workflow_run_id'),
      sequence: sql<number>`coalesce(max(${runEvents.sequence}),0)+1`.as(
        'sequence',
      ),
      type: sql<string>`${event.type}`.as('type'),
      payload: sql`${serializedPayload}::jsonb`.as('payload'),
      createdAt: sql<Date>`now()`.as('created_at'),
    })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, transaction.workspaceId),
        eq(runEvents.workflowRunId, runId),
      ),
    );
  const [inserted] = await transaction.db
    .insert(runEvents)
    .select(next)
    .returning({ sequence: runEvents.sequence });
  const sequence = inserted?.sequence;
  if (sequence === undefined)
    throw new Error('Run event insert returned no sequence');
  return sequence;
}

/** The caller holds every run lock, in ID order, throughout the batch. */
export async function appendLockedRunEvents(
  transaction: WorkspaceTransaction,
  runIds: readonly string[],
  event: RunEvent,
): Promise<void> {
  if (runIds.length === 0) return;
  const { db, workspaceId } = transaction;
  const payload = serializeRunEventPayload(event.payload);
  const latest = db
    .select({ sequence: runEvents.sequence })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, workspaceId),
        eq(runEvents.workflowRunId, workflowRuns.id),
      ),
    )
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  await db.insert(runEvents).select(
    db
      .select({
        workspaceId: workflowRuns.workspaceId,
        workflowRunId: workflowRuns.id,
        sequence: sql<number>`coalesce((${latest}),0)+1`.as('sequence'),
        type: sql<string>`${event.type}`.as('type'),
        payload: sql`${payload}::jsonb`.as('payload'),
        createdAt: sql<Date>`now()`.as('created_at'),
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workspaceId, workspaceId),
          inArray(workflowRuns.id, [...runIds]),
        ),
      ),
  );
}

function serializeRunEventPayload(payload: unknown): string {
  let normalizedPayload: unknown;
  try {
    normalizedPayload = JSON.parse(serializeStoredExecutionJsonValue(payload));
  } catch {
    throw new ExecutionStateConflictError('execution.event_payload_invalid');
  }
  const invalidPayload =
    normalizedPayload === null ||
    typeof normalizedPayload !== 'object' ||
    Array.isArray(normalizedPayload);
  if (invalidPayload)
    throw new ExecutionStateConflictError('execution.event_payload_invalid');

  let serializedPayload: string;
  try {
    serializedPayload = serializeStoredExecutionJsonValue(normalizedPayload);
  } catch {
    throw new ExecutionStateConflictError('execution.event_payload_invalid');
  }
  if (utf8ByteLength(serializedPayload) > RUN_EVENT_PAYLOAD_MAX_BYTES)
    throw new ExecutionStateConflictError(
      `JSON value must not exceed ${String(RUN_EVENT_PAYLOAD_MAX_BYTES)} UTF-8 bytes`,
    );

  return serializedPayload;
}

export async function appendRunEvent(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; event: RunEvent }>,
): Promise<number> {
  const runId = input.runId;
  await lockRunForEvent(transaction, runId);
  return appendLockedRunEvent(transaction, runId, input.event);
}
