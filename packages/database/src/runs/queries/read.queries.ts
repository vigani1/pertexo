import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { RUN_DETAILS_RETENTION_SQL } from '../data-policy.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { withResourceRunRead } from '../../tenant-access/resources/transactions.repository.js';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { readErrorWorkflow } from '../error-workflows/read.queries.js';
import { readRunStalledSince } from '../stalled/overdue.queries.js';
import {
  readWorkflowCalls,
  type WorkflowCallReadRecord,
  type WorkflowParentCallReadRecord,
} from './history/calls.queries.js';
import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import type { ResourceTransaction } from '../../tenant-access/resources/contract.js';
import { WorkflowRunReadCapacityError } from '../errors.js';
import {
  readWorkflowRunReadRecord,
  type WorkflowRunReadRecord,
} from '../commands/records.repository.js';

interface GetInput {
  workspaceId: string;
  actorId: string;
  runId: string;
  includeWorkflowName?: boolean;
  signal?: AbortSignal | undefined;
}
export type GetWorkflowRunInput = Readonly<GetInput>;

// Read projection combines stored columns with computed or joined fields.
export type WorkflowNodeRunRecord = Readonly<{
  id: string;
  nodeId: string;
  invocationKey: string;
  status: typeof nodeRuns.$inferSelect.status;
  currentAttemptNumber: number;
  failureHandling?: Readonly<{
    entryInvocationKey: string;
    sinkInvocationKey: string;
    disposition: 'pending' | 'handled';
  }>;
  reused?: Readonly<{
    sourceRunId: string;
    sourceNodeRunId: string;
    sourceCompletedAt: string;
  }>;
  startedAt: Date | null;
  completedAt: Date | null;
  resumeAt: Date | null;
  errorSummary?: string;
  safeErrorCode: string | null;
}>;

export type WorkflowRunReadModel = Readonly<{
  run: WorkflowRunReadRecord;
  nodes: readonly WorkflowNodeRunRecord[];
  calls?: readonly WorkflowCallReadRecord[];
  parentCall?: WorkflowParentCallReadRecord;
  errorWorkflow?: WorkflowRunErrorWorkflow;
}>;

/** One run and its node runs, read in a workspace-scoped snapshot. */
export async function readWorkflowRun(
  pool: Pool,
  input: GetWorkflowRunInput,
): Promise<WorkflowRunReadModel | undefined> {
  return withResourceRunRead(pool, input, async (transaction) =>
    readRunModel(transaction, input.runId, {
      includeWorkflowName: input.includeWorkflowName ?? false,
    }),
  );
}

async function readRunModel(
  transaction: ResourceTransaction,
  runId: string,
  { includeWorkflowName }: Readonly<{ includeWorkflowName: boolean }>,
): Promise<WorkflowRunReadModel | undefined> {
  const run = await readWorkflowRunReadRecord(transaction, runId, {
    includeWorkflowName,
  });
  if (run === undefined) return undefined;
  const stalledSince =
    run.status === 'running' || run.status === 'waiting'
      ? await readRunStalledSince(transaction.db, {
          workspaceId: transaction.workspaceId,
          runId,
        })
      : undefined;
  const nodes = await readNodes(transaction, runId);
  if (nodes.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations)
    throw new WorkflowRunReadCapacityError();
  return Object.freeze({
    run:
      stalledSince === undefined
        ? run
        : Object.freeze({
            ...run,
            stalled: { since: stalledSince.toISOString() },
          }),
    ...(await readWorkflowCalls(transaction, runId)),
    ...(await readErrorWorkflow(transaction, runId)),
    nodes: Object.freeze(nodes.map(toNodeRecord)),
  });
}

function toNodeRecord(
  row: Awaited<ReturnType<typeof readNodes>>[number],
): WorkflowNodeRunRecord {
  const {
    failure_handler_entry_key,
    failure_handler_sink_key,
    failure_handling,
    reused_source_run_id,
    reused_source_node_run_id,
    reused_source_completed_at,
  } = row;
  const incompleteFailureHandler =
    failure_handler_entry_key === null ||
    failure_handler_sink_key === null ||
    failure_handling === null;
  const incompleteReusedSource =
    reused_source_run_id === null ||
    reused_source_node_run_id === null ||
    reused_source_completed_at === null;
  return Object.freeze({
    id: row.id,
    nodeId: row.node_id,
    invocationKey: row.invocation_key,
    status: row.status,
    currentAttemptNumber: row.current_attempt_number,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resumeAt: row.resume_at,
    safeErrorCode: row.safe_error_code,
    ...(row.error_summary === null ? {} : { errorSummary: row.error_summary }),
    ...(incompleteFailureHandler
      ? {}
      : {
          failureHandling: {
            entryInvocationKey: failure_handler_entry_key,
            sinkInvocationKey: failure_handler_sink_key,
            disposition: failure_handling,
          },
        }),
    ...(incompleteReusedSource
      ? {}
      : {
          reused: {
            sourceRunId: reused_source_run_id,
            sourceNodeRunId: reused_source_node_run_id,
            sourceCompletedAt: reused_source_completed_at.toISOString(),
          },
        }),
  });
}

function readNodes({ db, workspaceId }: WorkspaceTransaction, runId: string) {
  const errorSummary = db
    .select({ value: nodeAttempts.errorSummary })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
        eq(nodeAttempts.id, nodeRuns.currentAttemptId),
        eq(nodeAttempts.safeErrorCode, nodeRuns.safeErrorCode),
      ),
    );
  // What a service answered is provider text, so it goes when the run's other details do.
  const keptRun = alias(workflowRuns, 'run');
  const detailsKept = db
    .select({ one: sql`1` })
    .from(keptRun)
    .where(
      and(
        eq(keptRun.workspaceId, nodeRuns.workspaceId),
        eq(keptRun.id, nodeRuns.workflowRunId),
        isNull(keptRun.detailsPurgedAt),
        sql`(${keptRun.completedAt} is null or ${keptRun.completedAt}>statement_timestamp()-${RUN_DETAILS_RETENTION_SQL})`,
      ),
    );
  return db
    .select({
      id: nodeRuns.id,
      node_id: nodeRuns.nodeId,
      invocation_key: nodeRuns.invocationKey,
      status: nodeRuns.status,
      current_attempt_number: sql<number>`coalesce(${nodeRuns.currentAttemptNumber},0)`,
      started_at: nodeRuns.startedAt,
      completed_at: nodeRuns.completedAt,
      resume_at:
        sql<Date | null>`case when ${nodeRuns.controlKind}='human_task' then null else coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt}) end`.mapWith(
          nodeRuns.resumeAt,
        ),
      safe_error_code: nodeRuns.safeErrorCode,
      error_summary: sql<
        string | null
      >`case when ${nodeRuns.safeErrorCode} in ('execution.file_input','execution.attempt_invalid') or ${nodeRuns.safeErrorCode} like 'http.oauth2\_%' then (${errorSummary})
        when ${nodeRuns.safeErrorCode} in ('execution.provider','execution.authentication','execution.rate_limit','execution.timeout')
          and ${exists(detailsKept)} then (${errorSummary}) end`,
      failure_handler_entry_key: nodeRuns.failureHandlerEntryKey,
      failure_handler_sink_key: nodeRuns.failureHandlerSinkKey,
      failure_handling: nodeRuns.failureHandling,
      reused_source_run_id: nodeRuns.reusedSourceRunId,
      reused_source_node_run_id: nodeRuns.reusedSourceNodeRunId,
      reused_source_completed_at: nodeRuns.reusedSourceCompletedAt,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
      ),
    )
    .orderBy(nodeRuns.createdAt, nodeRuns.id)
    .limit(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 1);
}
