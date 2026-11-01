import type { RunStatus, RecoveryNode } from '@pertexo/workflow-engine';
import { nodeRuns, workflowRuns, workflows } from '@pertexo/database/schema';
import { withResourceWorkflowRead } from '../../../tenant-access/resources/transactions.repository.js';
import { ordinaryRunSql } from '../../data-policy.js';
import { and, eq, sql, desc, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** How many of a workflow's newest runs step history looks at (ADR 051). */
const STEP_HISTORY_RUN_WINDOW = 100;

interface WorkflowInput {
  workspaceId: string;
  actorId: string;
  workflowId: string;
  signal?: AbortSignal | undefined;
}
interface StepRunsInput {
  workspaceId: string;
  actorId: string;
  workflowId: string;
  nodeId: string;
  limit: number;
  signal?: AbortSignal | undefined;
}

export type ReadWorkflowStepHealthInput = Readonly<WorkflowInput>;
export type ReadWorkflowStepRunsInput = Readonly<StepRunsInput>;

// Read projection combines stored columns with computed or joined fields.
export type WorkflowStepHealthRecord = Readonly<{
  nodeId: string;
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  lastStatus: RecoveryNode['status'];
  lastRanAt: Date;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
}>;

export type WorkflowStepHealthPage = Readonly<{
  runsConsidered: number;
  oldestRunAt: Date | null;
  items: readonly WorkflowStepHealthRecord[];
}>;

// Read projection combines stored columns with computed or joined fields.
export type WorkflowStepRunRecord = Readonly<{
  runId: string;
  runStatus: RunStatus;
  runCreatedAt: Date;
  workflowVersionId: string;
  nodeRunId: string;
  invocationKey: string;
  status: RecoveryNode['status'];
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  safeErrorCode: string | null;
}>;

/** The workflow's newest runs, the one window both reads share. */
function recentRuns(transaction: WorkspaceTransaction, workflowId: string) {
  return transaction.db.$with('recent').as(
    transaction.db
      .select({
        id: workflowRuns.id,
        status: workflowRuns.status,
        created_at: workflowRuns.createdAt,
        workflow_version_id: workflowRuns.workflowVersionId,
      })
      .from(workflowRuns)
      .where(
        and(
          ordinaryRunSql(),
          eq(workflowRuns.workspaceId, transaction.workspaceId),
          eq(workflowRuns.workflowId, workflowId),
        ),
      )
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(STEP_HISTORY_RUN_WINDOW),
  );
}

async function workflowExists(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<boolean> {
  const rows = await transaction.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
  return withResourceWorkflowRead(pool, input, async (transaction) => {
    if (!(await workflowExists(transaction, input.workflowId)))
      return undefined;
    const recent = recentRuns(transaction, input.workflowId);
    const [summary] = await transaction.db
      .with(recent)
      .select({
        runs_considered: sql<number>`count(*)::int`,
        oldest_run_at: sql<Date | null>`min(${recent.created_at})`.mapWith(
          workflowRuns.createdAt,
        ),
      })
      .from(recent);
    if (summary === undefined)
      throw new Error('Step history aggregate returned no row');
    const steps = await readStepHealth(transaction, recent);
    return Object.freeze({
      runsConsidered: summary.runs_considered,
      oldestRunAt: summary.oldest_run_at,
      items: Object.freeze(
        steps.map((row) => {
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
  });
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
  return withResourceWorkflowRead(pool, input, async (transaction) => {
    if (!(await workflowExists(transaction, input.workflowId)))
      return undefined;
    const recent = recentRuns(transaction, input.workflowId);
    const result = await transaction.db
      .with(recent)
      .select({
        run_id: recent.id,
        run_status: recent.status,
        run_created_at: recent.created_at,
        workflow_version_id: recent.workflow_version_id,
        node_run_id: nodeRuns.id,
        invocation_key: nodeRuns.invocationKey,
        status: nodeRuns.status,
        attempts: sql<number>`coalesce(${nodeRuns.currentAttemptNumber},0)`,
        started_at: nodeRuns.startedAt,
        completed_at: nodeRuns.completedAt,
        safe_error_code: nodeRuns.safeErrorCode,
      })
      .from(recent)
      .innerJoin(
        nodeRuns,
        and(
          eq(nodeRuns.workspaceId, transaction.workspaceId),
          eq(nodeRuns.workflowRunId, recent.id),
          eq(nodeRuns.nodeId, input.nodeId),
        ),
      )
      .where(isNull(nodeRuns.reusedSourceRunId))
      .orderBy(
        desc(recent.created_at),
        desc(recent.id),
        desc(nodeRuns.createdAt),
        desc(nodeRuns.id),
      )
      .limit(input.limit);
    return Object.freeze(
      result.map((row) => {
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
  });
}

function readStepHealth(
  transaction: WorkspaceTransaction,
  recent: ReturnType<typeof recentRuns>,
) {
  const n = nodeRuns;
  const duration = sql`extract(epoch from ${n.completedAt}-${n.startedAt})*1000`;
  const measured = sql`${n.status}='succeeded' and ${n.startedAt} is not null and ${n.completedAt} is not null`;
  // Each group contains a node, so its latest status and coalesced run time are non-null.
  return transaction.db
    .with(recent)
    .select({
      node_id: n.nodeId,
      runs: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter(where ${n.status}='succeeded')::int`,
      failed: sql<number>`count(*) filter(where ${n.status} in ('failed','timed_out','outcome_unknown'))::int`,
      skipped: sql<number>`count(*) filter(where ${n.status}='skipped')::int`,
      last_status: sql<
        RecoveryNode['status']
      >`(array_agg(${n.status} order by coalesce(${n.startedAt},${n.createdAt}) desc,${n.id} desc))[1]`,
      last_ran_at:
        sql<Date>`max(coalesce(${n.startedAt},${n.createdAt}))`.mapWith(
          n.createdAt,
        ),
      median_ms: sql<
        number | null
      >`round(percentile_cont(0.5) within group(order by ${duration}) filter(where ${measured}))::int`,
      p95_ms: sql<
        number | null
      >`round(percentile_cont(0.95) within group(order by ${duration}) filter(where ${measured}))::int`,
    })
    .from(recent)
    .innerJoin(
      n,
      and(
        eq(n.workspaceId, transaction.workspaceId),
        eq(n.workflowRunId, recent.id),
      ),
    )
    .where(isNull(n.reusedSourceRunId))
    .groupBy(n.nodeId)
    .orderBy(n.nodeId);
}
