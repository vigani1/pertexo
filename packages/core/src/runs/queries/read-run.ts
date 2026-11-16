import type { nodeRuns } from '@pertexo/database/schema';
import { withResourceRunRead } from '../access.js';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { readErrorWorkflow } from '../error-workflows/read.repository.js';
import { readRunStalledSince } from '../stalled/overdue.repository.js';
import {
  readWorkflowCalls,
  type WorkflowCallReadRecord,
  type WorkflowParentCallReadRecord,
} from './history/read-calls.js';
import { readNodes } from './run.repository.js';
import type { Pool } from 'pg';
import type { ResourceTransaction } from '../../shared/access/folder-access.types.js';
import { WorkflowRunReadCapacityError } from '../workflow-run.errors.js';
import type { WorkflowRunReadRecord } from '../commands/workflow-run-records.repository.js';
import { readWorkflowRunReadRecord } from '../commands/read-run-record.js';

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
