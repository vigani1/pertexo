import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../advance/contract.js';
export type PendingTaskAllowance = Readonly<{ count: number; limit: number }>;
/** Caller holds the workspace execution counter lock across admission. */
export async function readPendingTaskAllowance(
  client: PoolClient,
  workspaceId: string,
): Promise<PendingTaskAllowance> {
  const result = await client.query<PendingTaskAllowance>(
    `select version.queued_run_limit "limit",(select count(*)::int from app.pending_run_tasks task where task.workspace_id=current.workspace_id and task.consumed_at is null and (task.status in ('pending','prepared') or (task.kind='callback' and task.node_run_id is null and task.status='submitted'))) count from app.workspace_execution_entitlements current join app.workspace_execution_entitlement_versions version on version.workspace_id=current.workspace_id and version.version=current.current_version where current.workspace_id=$1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  return row;
}
export function hasPendingTaskCapacity(
  allowance: PendingTaskAllowance,
): boolean {
  return allowance.count < allowance.limit;
}
