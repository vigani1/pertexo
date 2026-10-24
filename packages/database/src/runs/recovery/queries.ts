import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  WORKFLOW_GRAPH_LIMITS,
  WORKFLOW_RECOVERY_LIMITS,
} from '@pertexo/workflow-model';
import type {
  RecoveryNode,
  RecoveryRefused,
  RecoveryValues,
} from '@pertexo/workflow-engine';
import { branchContextSchema } from '../../attempts/validation/shared.js';
import {
  executorErrorKindSchema,
  executorFailureKindSchema,
} from '../../attempts/validation/completion.js';
import {
  StoredExecutionValueInvalidError,
  type StoredExecutionValue,
  parseStoredExecutionValue,
} from '../../platform/stored-execution-value.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../errors.js';
import { readWorkflowRunRecord } from '../commands/records.js';
import { lockReplaySource, lockReplayVersion } from '../commands/replay.js';
import { parsePublishedWorkflowRow } from '../queries/execution/published.js';
import type { WorkflowRecoveryMetadata } from './contract.js';
import { nodeStatusSchema } from '../queries/read.js';
import {
  readWorkflowRunFailedSteps,
  runInputInTransaction,
} from '../queries/history/details.js';

const maximumAttemptRecords = 1_000;

const nodeSchema = z
  .object({
    id: z.uuid(),
    node_id: z.string(),
    invocation_key: z.string(),
    status: nodeStatusSchema,
    side_effect_class: z.enum(['safe', 'idempotent_with_key', 'unsafe']),
    current_attempt_id: z.uuid().nullable(),
    current_attempt_number: z.number().int().positive().nullable(),
    completed_at: z.coerce.date().nullable(),
    branch_context: branchContextSchema,
    reused_source_run_id: z.uuid().nullable(),
    reused_source_node_run_id: z.uuid().nullable(),
    reused_source_completed_at: z.coerce.date().nullable(),
  })
  .strict();
const attemptSchema = z
  .object({
    id: z.uuid(),
    node_run_id: z.uuid(),
    attempt_number: z.number().int().positive(),
    status: nodeStatusSchema,
    executor_failure_kind: executorFailureKindSchema.nullable(),
    executor_error_kind: executorErrorKindSchema.nullable(),
    executor_possibly_dispatched: z.boolean().nullable(),
    dispatch_marked: z.boolean(),
    retry_decision: z.string().nullable(),
  })
  .strict();

/** Snapshot reads never reserve; command reads hold source details against retirement. */
export async function readRecoveryMetadata(
  transaction: WorkspaceTransaction,
  runId: string,
  mode: 'snapshot' | 'locked',
): Promise<WorkflowRecoveryMetadata | RecoveryRefused> {
  try {
    if (mode === 'locked') await lockReplaySource(transaction, runId);
    const run = await readWorkflowRunRecord(transaction, runId);
    if (run === undefined) throw new WorkflowRunNotFoundError();
    if (run.status !== 'failed' && run.status !== 'outcome_unknown')
      return { kind: 'refused', reason: 'source_not_failed' };
    const workflow =
      mode === 'locked'
        ? await lockReplayVersion(
            transaction,
            run.workflowId,
            run.workflowVersionId,
          )
        : await readVersion(transaction, run.workflowId, run.workflowVersionId);
    const checkpoint = await transaction.db.execute(sql`
    select scheduler_state from app.run_checkpoints
    where workspace_id=${transaction.workspaceId} and workflow_run_id=${runId}
    ${mode === 'locked' ? sql`for share` : sql``}
  `);
    if (checkpoint.rows[0] === undefined)
      return { kind: 'refused', reason: 'values_expired' };
    const rows = await transaction.db.execute(sql`
    select id,node_id,invocation_key,status,side_effect_class,current_attempt_id,current_attempt_number,
      completed_at,branch_context,reused_source_run_id,reused_source_node_run_id,reused_source_completed_at
    from app.node_runs where workspace_id=${transaction.workspaceId} and workflow_run_id=${runId}
    order by id limit ${WORKFLOW_GRAPH_LIMITS.nodes + 1}
    ${mode === 'locked' ? sql`for share` : sql``}
  `);
    if (rows.rows.length > WORKFLOW_GRAPH_LIMITS.nodes)
      return { kind: 'refused', reason: 'unsupported_graph' };
    const parsed = rows.rows.map((row) => nodeSchema.parse(row));
    const ids = parsed.map((node) => node.id);
    const attempts = await transaction.db.execute(sql`
    select id,node_run_id,attempt_number,status,executor_failure_kind,executor_error_kind,
      executor_possibly_dispatched,dispatch_marked_at is not null as dispatch_marked,retry_decision
    from app.node_attempts where workspace_id=${transaction.workspaceId} and node_run_id=any(${sql.param(ids)}::uuid[])
    order by node_run_id,attempt_number limit ${maximumAttemptRecords + 1}
    ${mode === 'locked' ? sql`for share` : sql``}
  `);
    if (attempts.rows.length > maximumAttemptRecords)
      return { kind: 'refused', reason: 'reuse_bounds' };
    const attemptsByNode = new Map<
      string,
      RecoveryNode['attempts'][number][]
    >();
    for (const raw of attempts.rows) {
      const row = attemptSchema.parse(raw);
      const list = attemptsByNode.get(row.node_run_id) ?? [];
      list.push({
        id: row.id,
        number: row.attempt_number,
        status: row.status,
        failureKind: row.executor_failure_kind,
        errorKind: row.executor_error_kind,
        possiblyDispatched: row.executor_possibly_dispatched,
        dispatchMarked: row.dispatch_marked,
        retryDecision: row.retry_decision,
      });
      attemptsByNode.set(row.node_run_id, list);
    }
    const nodes: RecoveryNode[] = parsed.map((node) => {
      const {
        reused_source_run_id,
        reused_source_node_run_id,
        reused_source_completed_at,
      } = node;
      const incompleteReusedSource =
        reused_source_run_id === null ||
        reused_source_node_run_id === null ||
        reused_source_completed_at === null;
      return {
        id: node.id,
        nodeId: node.node_id,
        invocationKey: node.invocation_key,
        status: node.status,
        sideEffectClass: node.side_effect_class,
        currentAttemptId: node.current_attempt_id,
        currentAttemptNumber: node.current_attempt_number,
        completedAt: node.completed_at?.toISOString() ?? null,
        ...(node.branch_context.branchPath === undefined
          ? {}
          : { branchPath: node.branch_context.branchPath }),
        ...(node.branch_context.iterationPath === undefined
          ? {}
          : { iterationPath: node.branch_context.iterationPath }),
        ...(incompleteReusedSource
          ? {}
          : {
              reused: {
                sourceRunId: reused_source_run_id,
                sourceNodeRunId: reused_source_node_run_id,
                completedAt: reused_source_completed_at.toISOString(),
              },
            }),
        attempts: attemptsByNode.get(node.id) ?? [],
      };
    });
    const failedStep = (
      await readWorkflowRunFailedSteps(transaction, [runId])
    ).get(runId);
    return {
      run,
      workflow,
      checkpoint: checkpoint.rows[0].scheduler_state,
      nodes,
      failedStep:
        failedStep === undefined
          ? undefined
          : { nodeId: failedStep.nodeId, label: failedStep.label },
    };
  } catch (error) {
    if (error instanceof WorkflowRunNotExecutableError)
      return { kind: 'refused', reason: 'version_unavailable' };
    if (error instanceof z.ZodError)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    throw error;
  }
}

async function readVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  versionId: string,
) {
  const result = await transaction.db.execute(sql`
    select version.id,version.workspace_id,version.workflow_id,version.version_number,version.checksum,version.executable_json,
      workflow.lifecycle_status
    from app.workflow_versions version join app.workflows workflow
      on workflow.workspace_id=version.workspace_id and workflow.id=version.workflow_id
    where version.workspace_id=${transaction.workspaceId} and version.workflow_id=${workflowId} and version.id=${versionId}
  `);
  const row = result.rows[0];
  if (row === undefined) throw new WorkflowRunNotFoundError();
  if (row.lifecycle_status !== 'active')
    throw new WorkflowRunNotExecutableError();
  const { lifecycle_status: _, ...stored } = row;
  const projection = parsePublishedWorkflowRow(stored);
  if (projection === null) throw new WorkflowRunNotFoundError();
  return projection;
}

export async function readRecoveryValues(
  transaction: WorkspaceTransaction,
  runId: string,
  nodeRunIds: readonly string[],
): Promise<RecoveryValues | RecoveryRefused> {
  const size = await transaction.db.execute<{ bytes: number | string }>(sql`
    select coalesce((select octet_length(input_ref::text) from app.workflow_runs
      where workspace_id=${transaction.workspaceId} and id=${runId}),0) +
      coalesce(sum(coalesce(octet_length(node.output_ref::text),0) + coalesce(octet_length(attempt.output_ref::text),0)),0) as bytes
    from app.node_runs node left join app.node_attempts attempt
      on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id and attempt.node_run_id=node.id
    where node.workspace_id=${transaction.workspaceId} and node.workflow_run_id=${runId} and node.id=any(${sql.param([...nodeRunIds])}::uuid[])
  `);
  if (Number(size.rows[0]?.bytes ?? 0) > WORKFLOW_RECOVERY_LIMITS.storageBytes)
    return { kind: 'refused', reason: 'reuse_bounds' };
  try {
    const input = await runInputInTransaction(transaction, runId);
    if (input === undefined) throw new WorkflowRunNotFoundError();
    const rows = await transaction.db.execute(sql`
    select node.id,node.output_ref as node_output,attempt.output_ref as attempt_output
    from app.node_runs node left join app.node_attempts attempt
      on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id and attempt.node_run_id=node.id
    where node.workspace_id=${transaction.workspaceId} and node.workflow_run_id=${runId} and node.id=any(${sql.param([...nodeRunIds])}::uuid[])
  `);
    const outputs = new Map<
      string,
      {
        node: StoredExecutionValue | undefined;
        attempt: StoredExecutionValue | undefined;
      }
    >();
    for (const row of rows.rows)
      outputs.set(z.uuid().parse(row.id), {
        node:
          row.node_output === null
            ? undefined
            : parseStoredExecutionValue(row.node_output),
        attempt:
          row.attempt_output === null
            ? undefined
            : parseStoredExecutionValue(row.attempt_output),
      });
    return { input, outputs };
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    throw error;
  }
}
