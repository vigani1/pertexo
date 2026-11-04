import { sql } from 'drizzle-orm';
import { workspaces } from '@pertexo/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

type Executor = Pick<NodePgDatabase, 'execute'>;

/** Serializes a workspace's slot and pending-task counts; it's the last lock taken. */
export async function lockWorkspaceExecutionCounter(
  db: Executor,
  workspaceId: string,
): Promise<void> {
  await db
    .execute(sql`select app.lock_workspace_execution_counter(${workspaceId})`)
    .catch(rethrowQueryFailure);
}

/** Whether this run can take a slot under its entitlement version, right now. */
export async function activeCapacityAvailable(
  db: Executor,
  input: Readonly<{
    workspaceId: string;
    entitlementVersion: number;
    runId: string;
  }>,
): Promise<boolean> {
  // Callers already hold the workspace fence. Acquiring current-entitlement
  // locks here would invert them with a resuming run's pinned-version locks.
  const standing = await db
    .execute<{ status: string }>(
      sql`select ${workspaces.status} status from ${workspaces}
    where ${workspaces.id}=${input.workspaceId}::uuid`,
    )
    .catch(rethrowQueryFailure);
  const status = standing.rows[0]?.status;
  const capacity = await db
    .execute<{ available: boolean }>(
      sql`select app.workflow_run_active_capacity_available(${input.workspaceId},${input.entitlementVersion},${input.runId}) available`,
    )
    .catch(rethrowQueryFailure);
  return status === 'active' && (capacity.rows[0]?.available ?? false);
}
