import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { WorkflowRunReadCapacityError } from '../../errors.js';
import type { ResourceTransaction } from '../../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';

const callRow = z
  .object({
    id: z.uuid(),
    invocation_key: z.string(),
    parent_run_id: z.uuid(),
    target_workflow_id: z.uuid(),
    target_version_id: z.uuid(),
    child_run_id: z.uuid().nullable(),
    live_child_run_id: z.uuid().nullable(),
    status: z.enum([
      'pending',
      'accepted',
      'refused',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]),
    slot_lent: z.boolean(),
    details_retired: z.boolean(),
    safe_error_code: z.string().nullable(),
    child_visible: z.boolean(),
  })
  .strict();
export type WorkflowCallReadRecord = Readonly<{
  id: string;
  invocationKey: string;
  targetWorkflowId: string;
  targetVersionId: string;
  childRunId: string | null;
  childHistory: 'not_started' | 'retained' | 'expired' | 'unavailable';
  status: z.output<typeof callRow>['status'];
  slotLent: boolean;
  detailsRetired: boolean;
  safeErrorCode: string | null;
}>;
export type WorkflowParentCallReadRecord = Readonly<{
  id: string;
  parentRunId: string;
  invocationKey: string;
}>;

/** Both directions use the same authorized run snapshot and workspace fence. */
export async function readWorkflowCalls(
  transaction: ResourceTransaction,
  runId: string,
) {
  const result = await transaction.db.execute(sql`
    select id, invocation_key, parent_run_id, target_workflow_id, target_version_id,
      child_run_id, live_child_run_id, status, slot_lent,
      details_purged_at is not null details_retired, safe_error_code,
      ${workflowScopeSql(transaction.resources, sql`target_workflow_id`)} child_visible
    from app.workflow_calls
    where workspace_id=${transaction.workspaceId}
      and (parent_run_id=${runId} or (child_run_id=${runId} and exists (
        select 1 from app.workflow_runs parent where parent.workspace_id=app.workflow_calls.workspace_id
        and parent.id=app.workflow_calls.parent_run_id
        and ${workflowScopeSql(transaction.resources, sql`parent.workflow_id`)})))
    order by invocation_key
    limit ${WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 2}
  `);
  if (result.rows.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations + 1)
    throw new WorkflowRunReadCapacityError();
  const calls: WorkflowCallReadRecord[] = [];
  let parentCall: WorkflowParentCallReadRecord | undefined;
  for (const value of result.rows) {
    const row = callRow.parse(value);
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
  row: z.output<typeof callRow>,
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
