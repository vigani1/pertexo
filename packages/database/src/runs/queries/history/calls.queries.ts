import { workflowCalls } from '../../../schema/runs/calls.js';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { alias } from 'drizzle-orm/pg-core';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { and, eq, exists, or, sql } from 'drizzle-orm';
import { WorkflowRunReadCapacityError } from '../../errors.js';
import type { ResourceTransaction } from '../../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';

// Read projection combines stored columns with computed or joined fields.
export type WorkflowCallReadRecord = Readonly<{
  id: string;
  invocationKey: string;
  targetWorkflowId: string;
  targetVersionId: string;
  childRunId: string | null;
  childHistory: 'not_started' | 'retained' | 'expired' | 'unavailable';
  status: typeof workflowCalls.$inferSelect.status;
  slotLent: boolean;
  detailsRetired: boolean;
  safeErrorCode: string | null;
}>;
export type WorkflowParentCallReadRecord = Readonly<
  Pick<
    typeof workflowCalls.$inferSelect,
    'id' | 'parentRunId' | 'invocationKey'
  >
>;

/** Both directions use the same authorized run snapshot and workspace fence. */
export async function readWorkflowCalls(
  transaction: ResourceTransaction,
  runId: string,
) {
  const result = await callRows(transaction, runId);
  if (result.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 1)
    throw new WorkflowRunReadCapacityError();
  const calls: WorkflowCallReadRecord[] = [];
  let parentCall: WorkflowParentCallReadRecord | undefined;
  for (const row of result) {
    if (row.parent_run_id !== runId) {
      parentCall = {
        id: row.id,
        parentRunId: row.parent_run_id,
        invocationKey: row.invocation_key,
      };
      continue;
    }
    calls.push({
      id: row.id,
      invocationKey: row.invocation_key,
      targetWorkflowId: row.target_workflow_id,
      targetVersionId: row.target_version_id,
      childRunId: row.child_visible ? row.child_run_id : null,
      childHistory: callHistoryState(row),
      status: row.status,
      slotLent: row.slot_lent,
      detailsRetired: row.details_retired,
      safeErrorCode: row.safe_error_code,
    });
  }
  if (calls.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations)
    throw new WorkflowRunReadCapacityError();
  return {
    ...(calls.length === 0 ? {} : { calls }),
    ...(parentCall === undefined ? {} : { parentCall }),
  };
}

function callHistoryState(
  row: Awaited<ReturnType<typeof callRows>>[number],
): WorkflowCallReadRecord['childHistory'] {
  if (row.child_run_id === null) {
    return 'not_started';
  }
  if (!row.child_visible) {
    return 'unavailable';
  }
  if (row.live_child_run_id === null) {
    return 'expired';
  }
  return 'retained';
}

function callRows(transaction: ResourceTransaction, runId: string) {
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
    .limit(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 2);
}
