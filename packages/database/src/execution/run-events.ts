import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  ExecutionStateConflictError,
  RunEventGapError,
} from './execution-state.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';

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
  nodeSkipped: 'node.skipped',
  nodeCanceled: 'node.canceled',
  nodeTimedOut: 'node.timed_out',
  nodeOutcomeUnknown: 'node.outcome_unknown',
} as const;

export type RunEventType = (typeof RUN_EVENT_TYPE)[keyof typeof RUN_EVENT_TYPE];

const runEventSchema = z
  .object({
    type: z.enum(Object.values(RUN_EVENT_TYPE)),
    payload: z.unknown(),
  })
  .strict();

const readRunEventsSchema = z
  .object({
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500),
    runId: z.uuid(),
  })
  .strict();

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
  const result = await transaction.db.execute<{ id: string }>(sql`
    select id
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    for update
  `);
  if (result.rows[0] === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
}

export async function appendLockedRunEvent(
  transaction: WorkspaceTransaction,
  runId: string,
  event: z.input<typeof runEventSchema>,
): Promise<number> {
  const parsed = runEventSchema.parse(event);
  let normalizedPayload: unknown;
  try {
    normalizedPayload = JSON.parse(
      serializeStoredExecutionJsonValue(parsed.payload),
    ) as unknown;
  } catch {
    throw new ExecutionStateConflictError('execution.event_payload_invalid');
  }
  if (
    normalizedPayload === null ||
    typeof normalizedPayload !== 'object' ||
    Array.isArray(normalizedPayload)
  )
    throw new ExecutionStateConflictError('execution.event_payload_invalid');

  const versionedPayload: Record<string, unknown> = Object.create(
    null,
  ) as Record<string, unknown>;
  Object.assign(versionedPayload, normalizedPayload);
  versionedPayload.schemaVersion = 1;

  let serializedPayload: string;
  try {
    serializedPayload = serializeStoredExecutionJsonValue(versionedPayload);
  } catch {
    throw new ExecutionStateConflictError('execution.event_payload_invalid');
  }
  if (Buffer.byteLength(serializedPayload, 'utf8') > 4096)
    throw new ExecutionStateConflictError(
      'JSON value must not exceed 4096 UTF-8 bytes',
    );

  const result = await transaction.db.execute<{ sequence: number }>(sql`
    insert into app.run_events (workspace_id, workflow_run_id, sequence, type, payload)
    select
      ${transaction.workspaceId},
      ${runId},
      coalesce(max(sequence), 0) + 1,
      ${parsed.type},
      ${serializedPayload}::jsonb
    from app.run_events
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${runId}
    returning sequence
  `);
  const sequence = result.rows[0]?.sequence;
  if (sequence === undefined)
    throw new Error('Run event insert returned no sequence');
  return sequence;
}

export async function appendRunEvent(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; event: z.input<typeof runEventSchema> }>,
): Promise<number> {
  const runId = z.uuid().parse(input.runId);
  await lockRunForEvent(transaction, runId);
  return appendLockedRunEvent(transaction, runId, input.event);
}

export async function readRunEventsAfter(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof readRunEventsSchema>>,
): Promise<RunEventPage> {
  const parsed = readRunEventsSchema.parse(input);
  const run = await transaction.db.execute<{ high_water: number }>(sql`
    select coalesce(max(e.sequence), 0)::integer as high_water
    from app.workflow_runs r
    left join app.run_events e
      on e.workspace_id = r.workspace_id and e.workflow_run_id = r.id
    where r.workspace_id = ${transaction.workspaceId} and r.id = ${parsed.runId}
    group by r.id
  `);
  const highWaterSequence = run.rows[0]?.high_water;
  if (highWaterSequence === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');

  const result = await transaction.db.execute<{
    created_at: Date;
    payload: unknown;
    sequence: number;
    type: RunEventType;
  }>(sql`
    select sequence, type, payload, created_at
    from app.run_events
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${parsed.runId}
      and sequence > ${parsed.afterSequence}
    order by sequence
    limit ${parsed.limit + 1}
  `);
  const pageRows = result.rows.slice(0, parsed.limit);
  for (const [index, row] of pageRows.entries()) {
    if (row.sequence !== parsed.afterSequence + index + 1)
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
    hasMore: result.rows.length > parsed.limit,
    highWaterSequence,
  });
}
