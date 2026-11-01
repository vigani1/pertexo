import { runEvents, workflowRuns } from '@pertexo/database/schema';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { retainedTestRunSql } from '../../data-policy.js';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ExecutionStateConflictError,
  RunEventGapError,
} from '../../state-errors.js';
import { serializeStoredExecutionJsonValue } from '../../values/stored-execution.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

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

interface ReadRunEvents {
  afterSequence: number;
  limit: number;
  runId: string;
}

export type PersistedRunEvent = Readonly<{
  createdAt: Date;
  payload: unknown;
  sequence: number;
  type: RunEventType;
}>;

export type RunEventPage = Readonly<{
  events: readonly PersistedRunEvent[];
  hasMore: boolean;
  highWaterSequence: number;
}>;

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
  let normalizedPayload: unknown;
  try {
    normalizedPayload = JSON.parse(
      serializeStoredExecutionJsonValue(event.payload),
    );
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
  if (utf8ByteLength(serializedPayload) > 4096)
    throw new ExecutionStateConflictError(
      'JSON value must not exceed 4096 UTF-8 bytes',
    );

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

export async function appendRunEvent(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; event: RunEvent }>,
): Promise<number> {
  const runId = input.runId;
  await lockRunForEvent(transaction, runId);
  return appendLockedRunEvent(transaction, runId, input.event);
}

export async function readRunEventsAfter(
  transaction: WorkspaceTransaction,
  input: Readonly<ReadRunEvents>,
): Promise<RunEventPage> {
  const { snapshot, page } = eventPage(transaction, input);
  // Drizzle cannot mark a CTE MATERIALIZED; retain the snapshot barrier around native reads.
  type PageRow = (typeof page)['_']['result'][number];
  type WireRow = Omit<PageRow, 'created_at'> &
    Readonly<{ created_at: string | null }>;
  const result = await transaction.db.execute<WireRow>(
    sql`with run_snapshot as materialized (${snapshot}) ${page}`,
  );
  const highWaterSequence = result.rows[0]?.high_water;
  if (highWaterSequence === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
  const eventRows = result.rows.filter(
    (
      row,
    ): row is typeof row & {
      created_at: string;
      sequence: number;
      type: RunEventType;
    } => row.created_at !== null && row.sequence !== null && row.type !== null,
  );
  const pageRows = eventRows.slice(0, input.limit);
  for (const [index, row] of pageRows.entries()) {
    if (row.sequence !== input.afterSequence + index + 1)
      throw new RunEventGapError();
  }

  return Object.freeze({
    events: Object.freeze(
      pageRows.map((row) =>
        Object.freeze({
          createdAt: z.coerce.date().parse(row.created_at),
          payload: row.payload,
          sequence: row.sequence,
          type: row.type,
        }),
      ),
    ),
    hasMore: eventRows.length > input.limit,
    highWaterSequence,
  });
}

function eventPage(transaction: WorkspaceTransaction, input: ReadRunEvents) {
  const { db, workspaceId } = transaction;
  const highWater = db
    .select({ value: sql<number>`max(${runEvents.sequence})` })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, workflowRuns.workspaceId),
        eq(runEvents.workflowRunId, workflowRuns.id),
      ),
    );
  const snapshot = db
    .select({
      high_water: sql<number>`coalesce((${highWater}),0)::integer`.as(
        'high_water',
      ),
    })
    .from(workflowRuns)
    .where(
      and(
        retainedTestRunSql(),
        eq(workflowRuns.workspaceId, workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    );
  const source = db.$with('run_snapshot').as(snapshot);
  // The outer left join can produce an empty page row, including computed fields.
  const events = db
    .select({
      sequence: runEvents.sequence,
      type: sql<RunEventType | null>`${runEvents.type}`.as('type'),
      payload: runEvents.payload,
      created_at: runEvents.createdAt,
    })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, workspaceId),
        eq(runEvents.workflowRunId, input.runId),
        gt(runEvents.sequence, input.afterSequence),
        lte(runEvents.sequence, source.high_water),
      ),
    )
    .orderBy(runEvents.sequence)
    .limit(input.limit + 1)
    .as('page');
  const page = db
    .select({
      high_water: source.high_water,
      sequence: events.sequence,
      type: events.type,
      payload: events.payload,
      created_at: events.created_at,
    })
    .from(source)
    .leftJoinLateral(events, sql`true`)
    .orderBy(sql`${events.sequence} nulls last`);
  return { snapshot, page };
}
