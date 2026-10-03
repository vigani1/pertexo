import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  withWorkspaceReadTransaction,
  type WorkspaceTransaction,
} from '../../tenant-access/workspace.js';
import { WorkflowRunReadCapacityError } from './workflow-run-errors.js';
import {
  readWorkflowRunCallFamily,
  type WorkflowRunCallFamily,
} from './workflow-run-call-family.js';
import {
  readWorkflowRunReadRecord,
  type WorkflowRunReadRecord,
} from './workflow-run-persistence-support.js';

const getInputSchema = z
  .object({
    workspaceId: z.uuid(),
    runId: z.uuid(),
    includeWorkflowName: z.boolean().default(false),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export type GetWorkflowRunInput = Readonly<z.input<typeof getInputSchema>>;

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
    safe_error_code: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type WorkflowNodeRunRecord = Readonly<{
  id: string;
  nodeId: string;
  invocationKey: string;
  status: z.output<typeof nodeStatusSchema>;
  currentAttemptNumber: number;
  startedAt: Date | null;
  completedAt: Date | null;
  resumeAt: Date | null;
  safeErrorCode: string | null;
}>;

export type WorkflowRunReadModel = Readonly<{
  run: WorkflowRunReadRecord;
  nodes: readonly WorkflowNodeRunRecord[];
  callFamily?: WorkflowRunCallFamily;
}>;

/** One run and its node runs, read in a workspace-scoped snapshot. */
export async function readWorkflowRun(
  pool: Pool,
  input: GetWorkflowRunInput,
): Promise<WorkflowRunReadModel | undefined> {
  const parsed = getInputSchema.parse(input);
  return withWorkspaceReadTransaction(
    pool,
    parsed.workspaceId,
    async (transaction) =>
      readRunModel(transaction, parsed.runId, parsed.includeWorkflowName),
    parsed.signal === undefined ? {} : { signal: parsed.signal },
  );
}

async function readRunModel(
  transaction: WorkspaceTransaction,
  runId: string,
  includeWorkflowName: boolean,
): Promise<WorkflowRunReadModel | undefined> {
  const run = await readWorkflowRunReadRecord(
    transaction,
    runId,
    includeWorkflowName,
  );
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
      coalesce(retry_due_at, resume_at) as resume_at,
      safe_error_code
    from app.node_runs
    where workspace_id = ${transaction.workspaceId}
      and workflow_run_id = ${runId}
    order by created_at, id
    limit 1001
  `);
  if (nodes.rows.length > 1_000) throw new WorkflowRunReadCapacityError();
  const callFamily = await readWorkflowRunCallFamily(transaction, runId);
  return Object.freeze({
    run,
    nodes: Object.freeze(nodes.rows.map(toNodeRecord)),
    ...(callFamily === undefined ? {} : { callFamily }),
  });
}

function toNodeRecord(value: unknown): WorkflowNodeRunRecord {
  const row = nodeRowSchema.parse(value);
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
  });
}
