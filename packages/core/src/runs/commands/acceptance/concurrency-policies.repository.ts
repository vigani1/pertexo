import { workflowConcurrencyPolicies } from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** Calls and tests skip workflow concurrency; the skip protocol still records that. */
export async function skipWorkflowConcurrency(
  transaction: WorkspaceTransaction,
) {
  await transaction.db.execute(
    sql`select set_config('app.workflow_concurrency_skip_protocol','1',true)`,
  );
}

/** Serializes the workspace's admissions before reading a workflow's policy. */
export async function lockWorkflowConcurrency(
  transaction: WorkspaceTransaction,
) {
  await transaction.db.execute(
    sql`select app.lock_workspace_admission(${transaction.workspaceId}),set_config('app.workflow_concurrency_skip_protocol','1',true)`,
  );
}

export async function readConcurrencyPolicy(
  transaction: WorkspaceTransaction,
  workflowId: string,
) {
  const [policy] = await transaction.db
    .select({
      active_run_limit: workflowConcurrencyPolicies.activeRunLimit,
      overflow: workflowConcurrencyPolicies.overflow,
    })
    .from(workflowConcurrencyPolicies)
    .where(
      and(
        eq(workflowConcurrencyPolicies.workspaceId, transaction.workspaceId),
        eq(workflowConcurrencyPolicies.workflowId, workflowId),
      ),
    );
  return policy;
}

/** The workflow's active and queued runs; reservations are a subset of queued runs. */
export async function readWorkflowOccupancy(
  transaction: WorkspaceTransaction,
  workflowId: string,
) {
  const occupancy = await transaction.db.execute<{
    active_runs: number;
    queued_runs: number;
  }>(sql`
      select active_runs,queued_runs from app.workflow_run_slot_counts(${transaction.workspaceId}::uuid,${workflowId}::uuid)
    `);
  return occupancy.rows[0];
}
