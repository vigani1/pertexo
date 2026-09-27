import { sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  withWorkspaceReadTransaction,
  type WorkspaceTransaction,
} from '../../tenant-access/workspace.js';

/** How many of a workflow's newest runs step history looks at (ADR 051). */
const STEP_HISTORY_RUN_WINDOW = 100;

const nodeStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

const workflowInputSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
const stepRunsInputSchema = workflowInputSchema
  .extend({
    nodeId: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(50),
  })
  .strict();

export type ReadWorkflowStepHealthInput = Readonly<
  z.input<typeof workflowInputSchema>
>;
export type ReadWorkflowStepRunsInput = Readonly<
  z.input<typeof stepRunsInputSchema>
>;

export type WorkflowStepHealthRecord = Readonly<{
  nodeId: string;
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  lastStatus: z.output<typeof nodeStatusSchema>;
  lastRanAt: Date;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
}>;

export type WorkflowStepHealthPage = Readonly<{
  runsConsidered: number;
  oldestRunAt: Date | null;
  items: readonly WorkflowStepHealthRecord[];
}>;

export type WorkflowStepRunRecord = Readonly<{
  runId: string;
  runStatus: z.output<typeof runStatusSchema>;
  runCreatedAt: Date;
  workflowVersionId: string;
  nodeRunId: string;
  invocationKey: string;
  status: z.output<typeof nodeStatusSchema>;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  safeErrorCode: string | null;
}>;

const windowRowSchema = z
  .object({
    runs_considered: z.number().int().nonnegative(),
    oldest_run_at: z.coerce.date().nullable(),
  })
  .strict();
const healthRowSchema = z
  .object({
    node_id: z.string().min(1).max(256),
    runs: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    last_status: nodeStatusSchema,
    last_ran_at: z.coerce.date(),
    median_ms: z.number().int().nonnegative().nullable(),
    p95_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();
const stepRunRowSchema = z
  .object({
    run_id: z.uuid(),
    run_status: runStatusSchema,
    run_created_at: z.coerce.date(),
    workflow_version_id: z.uuid(),
    node_run_id: z.uuid(),
    invocation_key: z.string().min(1).max(1_024),
    status: nodeStatusSchema,
    attempts: z.number().int().nonnegative(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    safe_error_code: z.string().min(1).max(128).nullable(),
  })
  .strict();

/** The workflow's newest runs, the one window both reads share. */
function recentRuns(
  transaction: WorkspaceTransaction,
  workflowId: string,
): SQL {
  return sql`
    select id, status, created_at, workflow_version_id
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId}
      and workflow_id = ${workflowId}
    order by created_at desc, id desc
    limit ${STEP_HISTORY_RUN_WINDOW}
  `;
}

async function workflowExists(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<boolean> {
  const result = await transaction.db.execute(sql`
    select 1 from app.workflows
    where workspace_id = ${transaction.workspaceId} and id = ${workflowId}
    limit 1
  `);
  return result.rows.length > 0;
}

/**
 * Every step that ran in the workflow's last 100 runs: how often, how it
 * ended, its latest status, and how long its successful runs took.
 * `undefined` when the workflow isn't in the workspace.
 */
export async function readWorkflowStepHealth(
  pool: Pool,
  input: ReadWorkflowStepHealthInput,
): Promise<WorkflowStepHealthPage | undefined> {
  const parsed = workflowInputSchema.parse(input);
  return withWorkspaceReadTransaction(
    pool,
    parsed.workspaceId,
    async (transaction) => {
      if (!(await workflowExists(transaction, parsed.workflowId)))
        return undefined;
      const recent = recentRuns(transaction, parsed.workflowId);
      const window = await transaction.db.execute(sql`
        with recent as (${recent})
        select count(*)::int as runs_considered,
               min(created_at) as oldest_run_at
        from recent
      `);
      const steps = await transaction.db.execute(sql`
        with recent as (${recent})
        select
          node.node_id,
          count(*)::int as runs,
          count(*) filter (where node.status = 'succeeded')::int as succeeded,
          count(*) filter (
            where node.status in ('failed', 'timed_out', 'outcome_unknown')
          )::int as failed,
          count(*) filter (where node.status = 'skipped')::int as skipped,
          (array_agg(node.status order by
            coalesce(node.started_at, node.created_at) desc, node.id desc))[1]
            as last_status,
          max(coalesce(node.started_at, node.created_at)) as last_ran_at,
          round(percentile_cont(0.5) within group (order by
            extract(epoch from node.completed_at - node.started_at) * 1000)
            filter (where node.status = 'succeeded'
              and node.started_at is not null
              and node.completed_at is not null))::int as median_ms,
          round(percentile_cont(0.95) within group (order by
            extract(epoch from node.completed_at - node.started_at) * 1000)
            filter (where node.status = 'succeeded'
              and node.started_at is not null
              and node.completed_at is not null))::int as p95_ms
        from recent
        join app.node_runs node
          on node.workspace_id = ${transaction.workspaceId}
         and node.workflow_run_id = recent.id
        group by node.node_id
        order by node.node_id
      `);
      const summary = windowRowSchema.parse(window.rows[0]);
      return Object.freeze({
        runsConsidered: summary.runs_considered,
        oldestRunAt: summary.oldest_run_at,
        items: Object.freeze(
          steps.rows.map((value) => {
            const row = healthRowSchema.parse(value);
            return Object.freeze({
              nodeId: row.node_id,
              runs: row.runs,
              succeeded: row.succeeded,
              failed: row.failed,
              skipped: row.skipped,
              lastStatus: row.last_status,
              lastRanAt: row.last_ran_at,
              medianDurationMs: row.median_ms,
              p95DurationMs: row.p95_ms,
            });
          }),
        ),
      });
    },
    parsed.signal === undefined ? {} : { signal: parsed.signal },
  );
}

/**
 * One step's runs in the workflow's last 100 runs, newest first, each with
 * the run it belongs to. `undefined` when the workflow isn't in the
 * workspace; empty when the step never ran there.
 */
export async function readWorkflowStepRuns(
  pool: Pool,
  input: ReadWorkflowStepRunsInput,
): Promise<readonly WorkflowStepRunRecord[] | undefined> {
  const parsed = stepRunsInputSchema.parse(input);
  return withWorkspaceReadTransaction(
    pool,
    parsed.workspaceId,
    async (transaction) => {
      if (!(await workflowExists(transaction, parsed.workflowId)))
        return undefined;
      const result = await transaction.db.execute(sql`
        with recent as (${recentRuns(transaction, parsed.workflowId)})
        select
          recent.id as run_id,
          recent.status as run_status,
          recent.created_at as run_created_at,
          recent.workflow_version_id,
          node.id as node_run_id,
          node.invocation_key,
          node.status,
          coalesce(node.current_attempt_number, 0) as attempts,
          node.started_at,
          node.completed_at,
          node.safe_error_code
        from recent
        join app.node_runs node
          on node.workspace_id = ${transaction.workspaceId}
         and node.workflow_run_id = recent.id
         and node.node_id = ${parsed.nodeId}
        order by recent.created_at desc, recent.id desc,
                 node.created_at desc, node.id desc
        limit ${parsed.limit}
      `);
      return Object.freeze(
        result.rows.map((value) => {
          const row = stepRunRowSchema.parse(value);
          return Object.freeze({
            runId: row.run_id,
            runStatus: row.run_status,
            runCreatedAt: row.run_created_at,
            workflowVersionId: row.workflow_version_id,
            nodeRunId: row.node_run_id,
            invocationKey: row.invocation_key,
            status: row.status,
            attempts: row.attempts,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            safeErrorCode: row.safe_error_code,
          });
        }),
      );
    },
    parsed.signal === undefined ? {} : { signal: parsed.signal },
  );
}
