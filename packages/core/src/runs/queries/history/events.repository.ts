import { decodeStoredValue } from '../../../shared/stored-values.js';
import { runEvents, workflowRuns } from '@pertexo/database/schema';
import { retainedTestRunSql } from '../../../shared/run-records/run-retention.repository.js';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ExecutionStateConflictError } from '../../../shared/run-records/execution-state.errors.js';
import { RunEventGapError } from '../../advance/coordinator-state.errors.js';
import type { RunEventType } from '../../../shared/run-records/run-events.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

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
          createdAt: decodeStoredValue(() =>
            z.coerce.date().parse(row.created_at),
          ),
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
