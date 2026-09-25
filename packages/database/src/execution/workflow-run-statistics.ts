import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  withWorkspaceReadTransaction,
  type WorkspaceTransaction,
} from '../tenant-access/workspace.js';
import { runStatusSchema } from './workflow-run-persistence-support.js';

// Exact run counts for one workspace snapshot (ADR 044). Every statement
// reads one bounded index range: the non-terminal statuses, or the runs
// created inside a fixed window.

type RunStatus = z.output<typeof runStatusSchema>;
type CurrentStatus = Extract<RunStatus, 'queued' | 'running' | 'waiting'>;

/** Windows are whole hours so daylight-saving changes never skew them. */
const WINDOW_HOURS = Object.freeze({ '1h': 1, '6h': 6, '24h': 24, '7d': 168 });
const windowSchema = z.enum(['1h', '6h', '24h', '7d']);
const WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT = 50;
/** The read's cost ceiling: it never holds a pooled connection longer. */
const WORKFLOW_RUN_STATISTICS_STATEMENT_TIMEOUT_MILLIS = 2_000;

const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    window: windowSchema,
    includeWorkflows: z.boolean().default(false),
    includeWorkflowName: z.boolean().default(false),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export type WorkflowRunStatisticsDatabaseInput = Readonly<
  z.input<typeof inputSchema>
>;

export type WorkflowRunStatusCountRecord = Readonly<Record<RunStatus, number>>;

export type WorkflowRunWorkflowStatisticsRecord = Readonly<{
  workflowId: string;
  workflowName: string | null;
  total: number;
  byStatus: WorkflowRunStatusCountRecord;
}>;

export type WorkflowRunStatisticsRecord = Readonly<{
  asOf: string;
  current: Readonly<Record<CurrentStatus, number>>;
  window: Readonly<{
    duration: z.output<typeof windowSchema>;
    createdAtFrom: string;
    createdAtBefore: string;
    total: number;
    byStatus: WorkflowRunStatusCountRecord;
  }>;
  workflows?: Readonly<{
    items: readonly WorkflowRunWorkflowStatisticsRecord[];
    truncated: boolean;
  }>;
}>;

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const countSchema = z.number().int().nonnegative();
const currentRowSchema = z
  .object({
    as_of: timestampSchema,
    created_at_from: timestampSchema,
    queued: countSchema,
    running: countSchema,
    waiting: countSchema,
  })
  .strict();
const statusRowSchema = z
  .object({ status: runStatusSchema, run_count: countSchema })
  .strict();
const workflowRowSchema = statusRowSchema
  .extend({
    workflow_id: z.uuid(),
    total: countSchema,
    workflow_name: z.string().min(1).max(128).nullable(),
  })
  .strict();

function emptyCounts(): Record<RunStatus, number> {
  return Object.fromEntries(
    runStatusSchema.options.map((status) => [status, 0]),
  ) as Record<RunStatus, number>;
}

export async function readWorkflowRunStatistics(
  pool: Pool,
  input: WorkflowRunStatisticsDatabaseInput,
): Promise<WorkflowRunStatisticsRecord> {
  const parsed = inputSchema.parse(input);
  return withWorkspaceReadTransaction(
    pool,
    parsed.workspaceId,
    (transaction) => readInTransaction(transaction, parsed),
    {
      statementTimeoutMillis: WORKFLOW_RUN_STATISTICS_STATEMENT_TIMEOUT_MILLIS,
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    },
  );
}

async function readInTransaction(
  transaction: WorkspaceTransaction,
  input: z.output<typeof inputSchema>,
): Promise<WorkflowRunStatisticsRecord> {
  const hours = WINDOW_HOURS[input.window];
  // The transaction timestamp is fixed for the whole snapshot, so every
  // statement below shares the same window bounds and asOf.
  const current = currentRowSchema.parse(
    (
      await transaction.db.execute(sql`
        select
          to_char(transaction_timestamp() at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of,
          to_char(
            (transaction_timestamp() - make_interval(hours => ${hours}::integer))
              at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_from,
          (count(*) filter (where status = 'queued'))::integer as queued,
          (count(*) filter (where status = 'running'))::integer as running,
          (count(*) filter (where status = 'waiting'))::integer as waiting
        from app.workflow_runs
        where workspace_id = ${transaction.workspaceId}
          and status in ('queued', 'running', 'waiting')
      `)
    ).rows[0],
  );
  const statusRows = await transaction.db.execute(sql`
    select status, count(*)::integer as run_count
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId}
      and created_at >= transaction_timestamp()
        - make_interval(hours => ${hours}::integer)
      and created_at < transaction_timestamp()
    group by status
  `);
  const byStatus = emptyCounts();
  for (const row of statusRows.rows) {
    const { status, run_count: count } = statusRowSchema.parse(row);
    byStatus[status] = count;
  }
  return Object.freeze({
    asOf: current.as_of,
    current: Object.freeze({
      queued: current.queued,
      running: current.running,
      waiting: current.waiting,
    }),
    window: Object.freeze({
      duration: input.window,
      createdAtFrom: current.created_at_from,
      createdAtBefore: current.as_of,
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus: Object.freeze(byStatus),
    }),
    ...(input.includeWorkflows
      ? { workflows: await readWorkflowBreakdown(transaction, input, hours) }
      : {}),
  });
}

/** The window's busiest workflows, with one extra row to detect truncation. */
async function readWorkflowBreakdown(
  transaction: WorkspaceTransaction,
  input: z.output<typeof inputSchema>,
  hours: number,
): Promise<NonNullable<WorkflowRunStatisticsRecord['workflows']>> {
  const result = await transaction.db.execute(sql`
    with window_counts as (
      select workflow_id, status, count(*)::integer as run_count
      from app.workflow_runs
      where workspace_id = ${transaction.workspaceId}
        and created_at >= transaction_timestamp()
          - make_interval(hours => ${hours}::integer)
        and created_at < transaction_timestamp()
      group by workflow_id, status
    ),
    ranked as (
      select workflow_id, sum(run_count)::integer as total
      from window_counts
      group by workflow_id
      order by total desc, workflow_id
      limit ${WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT + 1}
    )
    select
      ranked.workflow_id, ranked.total, window_counts.status,
      window_counts.run_count,
      case when ${input.includeWorkflowName}::boolean
        then workflow.name else null end as workflow_name
    from ranked
    join window_counts on window_counts.workflow_id = ranked.workflow_id
    left join app.workflows workflow
      on workflow.workspace_id = ${transaction.workspaceId}
     and workflow.id = ranked.workflow_id
    order by ranked.total desc, ranked.workflow_id, window_counts.status
  `);
  const workflows = new Map<
    string,
    {
      workflowName: string | null;
      total: number;
      byStatus: Record<RunStatus, number>;
    }
  >();
  for (const value of result.rows) {
    const row = workflowRowSchema.parse(value);
    const known = workflows.get(row.workflow_id) ?? {
      workflowName: row.workflow_name,
      total: row.total,
      byStatus: emptyCounts(),
    };
    known.byStatus[row.status] = row.run_count;
    workflows.set(row.workflow_id, known);
  }
  const items = [...workflows.entries()].map(([workflowId, workflow]) =>
    Object.freeze({
      workflowId,
      workflowName: workflow.workflowName,
      total: workflow.total,
      byStatus: Object.freeze(workflow.byStatus),
    }),
  );
  return Object.freeze({
    items: Object.freeze(
      items.slice(0, WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT),
    ),
    truncated: items.length > WORKFLOW_RUN_STATISTICS_WORKFLOW_LIMIT,
  });
}
