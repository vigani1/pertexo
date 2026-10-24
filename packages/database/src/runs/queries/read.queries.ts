import { nodeRuns, nodeAttempts } from '../../schema/runs/execution.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { withResourceRunRead } from '../../tenant-access/resources/transactions.repository.js';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { readErrorWorkflow } from '../error-workflows/read.queries.js';
import {
  readWorkflowCalls,
  type WorkflowCallReadRecord,
  type WorkflowParentCallReadRecord,
} from './history/calls.queries.js';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { ResourceTransaction } from '../../tenant-access/resources/contract.js';
import { WorkflowRunReadCapacityError } from '../errors.js';
import {
  readWorkflowRunReadRecord,
  type WorkflowRunReadRecord,
} from '../commands/records.repository.js';

const getInputSchema = z
  .object({
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    runId: z.uuid(),
    includeWorkflowName: z.boolean().default(false),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export type GetWorkflowRunInput = Readonly<z.input<typeof getInputSchema>>;

export const nodeStatusSchema = z.enum([
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
export type WorkflowNodeRunRecord = Readonly<{
  id: string;
  nodeId: string;
  invocationKey: string;
  status: z.output<typeof nodeStatusSchema>;
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
  const parsed = getInputSchema.parse(input);
  return withResourceRunRead(pool, parsed, async (transaction) =>
    readRunModel(transaction, parsed.runId, {
      includeWorkflowName: parsed.includeWorkflowName,
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
  const nodes = await readNodes(transaction, runId);
  if (nodes.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations)
    throw new WorkflowRunReadCapacityError();
  return Object.freeze({
    run,
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
      >`case when ${nodeRuns.safeErrorCode} in ('execution.file_input','execution.attempt_invalid') then (${errorSummary}) end`,
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
