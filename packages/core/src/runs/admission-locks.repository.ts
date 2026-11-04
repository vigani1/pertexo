import { sql } from 'drizzle-orm';
import { workspaces } from '@pertexo/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

type Executor = Pick<NodePgDatabase, 'execute'>;

/**
 * Shares the workspace row. Lifecycle and purge hold it before run rows, so this
 * comes before any run, checkpoint or foreign-key write. Returns the workspace's
 * status, or undefined for one that isn't there.
 */
export async function lockWorkspaceRunAdmission(
  db: Executor,
  workspaceId: string,
): Promise<string | undefined> {
  const result = await db
    .execute<{ status: string | null }>(
      sql`select app.lock_workspace_run_admission(${workspaceId}) status`,
    )
    .catch(rethrowQueryFailure);
  return result.rows[0]?.status ?? undefined;
}

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
