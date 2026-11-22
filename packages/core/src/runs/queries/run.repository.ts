import {
  nodeRuns,
  nodeAttempts,
  pendingRunTasks,
  workflowRuns,
} from '@pertexo/database/schema';
import { RUN_DETAILS_RETENTION_SQL } from '../../shared/run-records/run-retention.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PendingTaskOutcome } from '@pertexo/workflow-engine';

/** The run's node runs in creation order, one past the graph's limit so an overfull run shows. */
export function readNodes(
  { db, workspaceId }: WorkspaceTransaction,
  runId: string,
) {
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
      approval_status: sql<
        PendingTaskOutcome['status'] | 'pending' | null
      >`${pendingRunTasks.status}`,
      dispatch_marked_at: nodeAttempts.dispatchMarkedAt,
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
        when ${exists(detailsKept)} then (${errorSummary}) end`,
      failure_handler_entry_key: nodeRuns.failureHandlerEntryKey,
      failure_handler_sink_key: nodeRuns.failureHandlerSinkKey,
      failure_handling: nodeRuns.failureHandling,
      reused_source_run_id: nodeRuns.reusedSourceRunId,
      reused_source_node_run_id: nodeRuns.reusedSourceNodeRunId,
      reused_source_completed_at: nodeRuns.reusedSourceCompletedAt,
    })
    .from(nodeRuns)
    .leftJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
        eq(nodeAttempts.id, nodeRuns.currentAttemptId),
      ),
    )
    .leftJoin(
      pendingRunTasks,
      and(
        eq(pendingRunTasks.workspaceId, nodeRuns.workspaceId),
        eq(pendingRunTasks.runId, nodeRuns.workflowRunId),
        eq(pendingRunTasks.invocationKey, nodeRuns.invocationKey),
        eq(pendingRunTasks.kind, 'approval'),
      ),
    )
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
      ),
    )
    .orderBy(nodeRuns.createdAt, nodeRuns.id)
    .limit(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 1);
}
