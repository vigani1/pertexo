import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

export async function readErrorWorkflow(
  transaction: WorkspaceTransaction,
  runId: string,
) {
  const result = await transaction.db.execute<WorkflowRunErrorWorkflow>(sql`
    select intent.status, intent.target_workflow_id as "targetWorkflowId",
      intent.target_version_id as "targetVersionId", target.id as "acceptedRunId",
      intent.refusal_code as "refusalCode"
      ,to_char(intent.queue_wait_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "queueWaitExpiresAt"
    from app.run_error_workflow_intents intent left join app.workflow_runs target
      on target.workspace_id=intent.workspace_id and target.id=intent.accepted_run_id
    where intent.workspace_id=${transaction.workspaceId} and intent.source_run_id=${runId}
  `);
  const row = result.rows[0];
  return row === undefined ? {} : { errorWorkflow: row };
}
