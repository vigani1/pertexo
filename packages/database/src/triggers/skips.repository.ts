import { usageEvents } from '../schema/foundation.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import { generatePersistedId } from '../platform/persisted-id.js';

/** The same immutable usage fact supplies history and counts, without event data. */
export async function recordWorkflowTriggerSkip(
  transaction: WorkspaceTransaction,
  workflowId: string,
  triggerType: 'webhook' | 'schedule' | 'form' | 'workflow_error',
): Promise<void> {
  const id = generatePersistedId();
  await transaction.db.insert(usageEvents).values({
    id,
    workspaceId: transaction.workspaceId,
    category: 'trigger.skipped',
    quantity: 1,
    resourceType: 'workflow',
    resourceId: workflowId,
    idempotencyKey: `trigger-skip:${id}`,
    metadata: { triggerType, reason: 'concurrency_limit' },
  });
}
