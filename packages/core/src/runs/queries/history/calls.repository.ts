import { workflowCalls, workflowRuns } from '@pertexo/database/schema';
import { alias } from 'drizzle-orm/pg-core';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { and, eq, exists, or, sql } from 'drizzle-orm';
import type { ResourceTransaction } from '../../../shared/access/folder-access.types.js';
import { workflowScopeSql } from '../../../shared/access/folder-scope.repository.js';

/** The run's child calls at most, and the one call that started it. */
export const CALL_ROWS = WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 1;

/** Both directions use the same authorized run snapshot and workspace fence. */
export function callRows(transaction: ResourceTransaction, runId: string) {
  const c = workflowCalls;
  const parent = alias(workflowRuns, 'parent');
  const visibleParent = transaction.db
    .select({ id: parent.id })
    .from(parent)
    .where(
      and(
        eq(parent.workspaceId, c.workspaceId),
        eq(parent.id, c.parentRunId),
        workflowScopeSql(transaction.resources, sql`${parent.workflowId}`),
      ),
    );
  return transaction.db
    .select({
      id: c.id,
      invocation_key: c.invocationKey,
      parent_run_id: c.parentRunId,
      target_workflow_id: c.targetWorkflowId,
      target_version_id: c.targetVersionId,
      child_run_id: c.childRunId,
      live_child_run_id: c.liveChildRunId,
      status: c.status,
      slot_lent: c.slotLent,
      details_retired: sql<boolean>`${c.detailsPurgedAt} is not null`,
      safe_error_code: c.safeErrorCode,
      child_visible: sql<boolean>`${workflowScopeSql(transaction.resources, sql`${c.targetWorkflowId}`)}`,
    })
    .from(c)
    .where(
      and(
        eq(c.workspaceId, transaction.workspaceId),
        or(
          eq(c.parentRunId, runId),
          and(eq(c.childRunId, runId), exists(visibleParent)),
        ),
      ),
    )
    .orderBy(c.invocationKey)
    .limit(CALL_ROWS + 1);
}
