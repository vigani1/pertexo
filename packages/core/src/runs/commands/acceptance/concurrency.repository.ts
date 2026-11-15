import { WorkflowAlreadyRunningError } from './run-admission.errors.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  lockWorkflowConcurrency,
  readConcurrencyPolicy,
  readWorkflowOccupancy,
  skipWorkflowConcurrency,
} from './concurrency-policies.repository.js';
import {
  concurrencyMayRefuse,
  concurrencyRefusesRun,
  skipsWorkflowConcurrency,
} from './concurrency.js';

/** Serialize immediately before insertion, after claims and artifact-reference locks. */
export async function requireWorkflowConcurrency(
  transaction: WorkspaceTransaction,
  workflowId: string,
  triggerType: string,
): Promise<void> {
  if (skipsWorkflowConcurrency(triggerType)) {
    await skipWorkflowConcurrency(transaction);
    return;
  }
  await lockWorkflowConcurrency(transaction);
  const policy = await readConcurrencyPolicy(transaction, workflowId);
  if (!concurrencyMayRefuse(policy)) return;
  const occupancy = await readWorkflowOccupancy(transaction, workflowId);
  if (occupancy === undefined)
    throw new Error('Workflow occupancy is unavailable');
  if (concurrencyRefusesRun(policy, occupancy))
    throw new WorkflowAlreadyRunningError();
}
