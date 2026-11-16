import type { workflowCalls } from '@pertexo/database/schema';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { WorkflowRunReadCapacityError } from '../../workflow-run.errors.js';
import type { ResourceTransaction } from '../../../shared/access/folder-access.types.js';
import { CALL_ROWS, callRows } from './calls.repository.js';

type CallRow = Awaited<ReturnType<typeof callRows>>[number];

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
  if (result.length > CALL_ROWS) throw new WorkflowRunReadCapacityError();
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
  row: CallRow,
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
