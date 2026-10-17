import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import { generatePersistedId } from '../platform/persisted-id.js';

/** The same immutable usage fact supplies history and counts, without event data. */
export async function recordWorkflowTriggerSkip(
  transaction: WorkspaceTransaction,
  workflowId: string,
  triggerType: 'webhook' | 'schedule' | 'form' | 'workflow_error',
): Promise<void> {
  const id = generatePersistedId();
  await transaction.db.execute(sql`
    insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata)
    values(${id},${transaction.workspaceId},'trigger.skipped',1,'workflow',${workflowId},${`trigger-skip:${id}`},${JSON.stringify({ triggerType, reason: 'concurrency_limit' })}::jsonb)
  `);
}
