import { withResourceRunRead } from '../../tenant-access/resources/transactions.repository.js';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { readErrorWorkflow } from '../error-workflows/read.js';
import {
  readWorkflowCalls,
  type WorkflowCallReadRecord,
  type WorkflowParentCallReadRecord,
} from './history/calls.js';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { ResourceTransaction } from '../../tenant-access/resources/transactions.repository.js';
import { WorkflowRunReadCapacityError } from '../errors.js';
import {
  readWorkflowRunReadRecord,
  type WorkflowRunReadRecord,
} from '../commands/records.js';

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
const nodeRowSchema = z
  .object({
    id: z.uuid(),
    node_id: z.string().min(1).max(128),
    invocation_key: z.string().min(1).max(256),
    status: nodeStatusSchema,
    current_attempt_number: z.number().int().nonnegative(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    resume_at: z.coerce.date().nullable(),
    error_summary: z.string().max(2048).nullable(),
    safe_error_code: z.string().min(1).max(128).nullable(),
    failure_handler_entry_key: z.string().min(1).max(256).nullable(),
    failure_handler_sink_key: z.string().min(1).max(256).nullable(),
    failure_handling: z.enum(['pending', 'handled']).nullable(),
    reused_source_run_id: z.uuid().nullable(),
    reused_source_node_run_id: z.uuid().nullable(),
    reused_source_completed_at: z.coerce.date().nullable(),
  })
  .strict();

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
  const nodes = await transaction.db.execute(sql`
    select
      id,
      node_id,
      invocation_key,
      status,
      coalesce(current_attempt_number, 0) as current_attempt_number,
      started_at,
      completed_at,
      case when control_kind='human_task' then null else coalesce(retry_due_at, resume_at) end as resume_at,
      safe_error_code,
      case when safe_error_code in ('execution.file_input','execution.attempt_invalid') then (
        select attempt.error_summary from app.node_attempts attempt
        where attempt.workspace_id = app.node_runs.workspace_id
          and attempt.node_run_id = app.node_runs.id
          and attempt.id = app.node_runs.current_attempt_id
          and attempt.safe_error_code = app.node_runs.safe_error_code
      ) end as error_summary,
      failure_handler_entry_key, failure_handler_sink_key, failure_handling,
      reused_source_run_id, reused_source_node_run_id, reused_source_completed_at
    from app.node_runs
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${runId}
    order by created_at, id
    limit ${WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 1}
  `);
  if (nodes.rows.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations)
    throw new WorkflowRunReadCapacityError();
  return Object.freeze({
    run,
    ...(await readWorkflowCalls(transaction, runId)),
    ...(await readErrorWorkflow(transaction, runId)),
    nodes: Object.freeze(nodes.rows.map(toNodeRecord)),
  });
}

function toNodeRecord(value: unknown): WorkflowNodeRunRecord {
  const row = nodeRowSchema.parse(value);
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
