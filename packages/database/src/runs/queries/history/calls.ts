import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { WorkflowRunReadCapacityError } from '../../errors.js';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

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
  })
  .strict();
export type WorkflowCallReadRecord = Readonly<{
  id: string;
  invocationKey: string;
  targetWorkflowId: string;
  targetVersionId: string;
  childRunId: string | null;
  childHistory: 'not_started' | 'retained' | 'expired';
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
  transaction: WorkspaceTransaction,
  runId: string,
) {
  const result = await transaction.db.execute(sql`
    select id, invocation_key, parent_run_id, target_workflow_id, target_version_id,
      child_run_id, live_child_run_id, status, slot_lent,
      details_purged_at is not null details_retired, safe_error_code
    from app.workflow_calls
    where workspace_id=${transaction.workspaceId}
      and (parent_run_id=${runId} or child_run_id=${runId})
    order by invocation_key limit 202
  `);
  if (result.rows.length > 201) throw new WorkflowRunReadCapacityError();
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
      childRunId: row.child_run_id,
      childHistory:
        row.child_run_id === null
          ? 'not_started'
          : row.live_child_run_id === null
            ? 'expired'
            : 'retained',
      status: row.status,
      slotLent: row.slot_lent,
      detailsRetired: row.details_retired,
      safeErrorCode: row.safe_error_code,
    });
  }
  return {
    ...(calls.length === 0 ? {} : { calls }),
    ...(parentCall === undefined ? {} : { parentCall }),
  };
}
