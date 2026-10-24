import { sql } from 'drizzle-orm';
import { isTestRun } from '../data-policy.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

export class WorkflowAlreadyRunningError extends Error {
  override readonly name = 'WorkflowAlreadyRunningError';
  constructor() {
    super('This workflow is already running. Try again shortly.');
  }
}

/** Serialize immediately before insertion, after claims and artifact-reference locks. */
export async function requireWorkflowConcurrency(
  transaction: WorkspaceTransaction,
  workflowId: string,
  triggerType: string,
): Promise<void> {
  if (triggerType === 'workflow_call' || isTestRun(triggerType)) {
    await transaction.db.execute(
      sql`select set_config('app.workflow_concurrency_skip_protocol','1',true)`,
    );
    return;
  }
  await transaction.db.execute(
    sql`select app.lock_workspace_admission(${transaction.workspaceId}),set_config('app.workflow_concurrency_skip_protocol','1',true)`,
  );
  const policies = await transaction.db.execute<{
    active_run_limit: number | null;
    overflow: string;
  }>(sql`
    select active_run_limit, overflow from app.workflow_concurrency_policies
    where workspace_id=${transaction.workspaceId} and workflow_id=${workflowId}
  `);
  const policy = policies.rows[0];
  if (policy?.overflow === 'skip' && policy.active_run_limit !== null) {
    // Reservations are a subset of queued runs here; adding them would count twice.
    const occupancy = await transaction.db.execute<{
      active_runs: number;
      queued_runs: number;
    }>(sql`
      select active_runs,queued_runs from app.workflow_run_slot_counts(${transaction.workspaceId}::uuid,${workflowId}::uuid)
    `);
    const counts = occupancy.rows[0];
    if (counts === undefined)
      throw new Error('Workflow occupancy is unavailable');
    if (counts.active_runs + counts.queued_runs >= policy.active_run_limit)
      throw new WorkflowAlreadyRunningError();
  }
}
