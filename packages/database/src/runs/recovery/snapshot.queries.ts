import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import {
  nodeRuns,
  nodeAttempts,
  runCheckpoints,
  workflowRuns,
} from '../../schema/runs/execution.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

export function readRecoveryCheckpoint(
  { db, workspaceId }: WorkspaceTransaction,
  runId: string,
  mode: 'snapshot' | 'locked',
) {
  const query = db
    .select({ scheduler_state: runCheckpoints.schedulerState })
    .from(runCheckpoints)
    .where(
      and(
        eq(runCheckpoints.workspaceId, workspaceId),
        eq(runCheckpoints.workflowRunId, runId),
      ),
    );
  return mode === 'locked' ? query.for('share') : query;
}
export function readRecoveryNodes(
  { db, workspaceId }: WorkspaceTransaction,
  runId: string,
  mode: 'snapshot' | 'locked',
) {
  const query = db
    .select({
      id: nodeRuns.id,
      node_id: nodeRuns.nodeId,
      invocation_key: nodeRuns.invocationKey,
      status: nodeRuns.status,
      side_effect_class: nodeRuns.sideEffectClass,
      current_attempt_id: nodeRuns.currentAttemptId,
      current_attempt_number: nodeRuns.currentAttemptNumber,
      completed_at: nodeRuns.completedAt,
      branch_context: nodeRuns.branchContext,
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
    .orderBy(nodeRuns.id)
    .limit(WORKFLOW_GRAPH_LIMITS.nodes + 1);
  return mode === 'locked' ? query.for('share') : query;
}
export function readRecoveryAttempts(
  { db, workspaceId }: WorkspaceTransaction,
  nodeIds: readonly string[],
  mode: 'snapshot' | 'locked',
) {
  const query = db
    .select({
      id: nodeAttempts.id,
      node_run_id: nodeAttempts.nodeRunId,
      attempt_number: nodeAttempts.attemptNumber,
      status: nodeAttempts.status,
      executor_failure_kind: nodeAttempts.executorFailureKind,
      executor_error_kind: nodeAttempts.executorErrorKind,
      executor_possibly_dispatched: nodeAttempts.executorPossiblyDispatched,
      dispatch_marked: sql<boolean>`${nodeAttempts.dispatchMarkedAt} is not null`,
      retry_decision: nodeAttempts.retryDecision,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.workspaceId, workspaceId),
        sql`${nodeAttempts.nodeRunId}=any(${sql.param([...nodeIds])}::uuid[])`,
      ),
    )
    .orderBy(nodeAttempts.nodeRunId, nodeAttempts.attemptNumber)
    .limit(1001);
  return mode === 'locked' ? query.for('share') : query;
}
function outputQuery(
  { db, workspaceId }: WorkspaceTransaction,
  runId: string,
  nodeIds: readonly string[],
) {
  return db
    .select({
      id: nodeRuns.id,
      node_output: nodeRuns.outputRef,
      attempt_output: nodeAttempts.outputRef,
    })
    .from(nodeRuns)
    .leftJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.id, nodeRuns.currentAttemptId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
      ),
    )
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        sql`${nodeRuns.id}=any(${sql.param([...nodeIds])}::uuid[])`,
      ),
    );
}
export function recoveryOutputs(
  transaction: WorkspaceTransaction,
  runId: string,
  nodeIds: readonly string[],
) {
  return outputQuery(transaction, runId, nodeIds);
}
export function recoverySize(
  transaction: WorkspaceTransaction,
  runId: string,
  nodeIds: readonly string[],
) {
  const inputSize = transaction.db
    .select({
      bytes: sql<number>`octet_length(${workflowRuns.inputRef}::text)`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    );
  const outputs = outputQuery(transaction, runId, nodeIds).as(
    'recovery_outputs',
  );
  return transaction.db
    .select({
      bytes: sql<string>`coalesce((${inputSize}),0)+coalesce(sum(coalesce(octet_length(${outputs.node_output}::text),0)+coalesce(octet_length(${outputs.attempt_output}::text),0)),0)`,
    })
    .from(outputs);
}
