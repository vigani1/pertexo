import { and, eq, sql } from 'drizzle-orm';
import {
  workspaceExecutionEntitlements as current,
  workspaceExecutionEntitlementVersions as version,
} from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/**
 * The workspace's current entitlement version, as epoch seconds. The caller
 * holds lock_workspace_run_admission, which already shares the pointer and
 * version rows for app and maintenance writers (the latter owns Calls).
 */
export async function readCurrentEntitlement(
  transaction: WorkspaceTransaction,
) {
  const [entitlement] = await transaction.db
    .select({
      status: version.status,
      effective_at: sql<string>`extract(epoch from ${version.effectiveAt})::text`,
      expires_at: sql<
        string | null
      >`extract(epoch from ${version.expiresAt})::text`,
    })
    .from(current)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, current.workspaceId),
        eq(version.version, current.currentVersion),
      ),
    )
    .where(eq(current.workspaceId, transaction.workspaceId));
  return entitlement;
}

/** The database clock as epoch seconds with its microseconds. */
export async function readAdmissionClock(transaction: WorkspaceTransaction) {
  const observed = await transaction.db.execute<{ now: string }>(
    sql`select extract(epoch from clock_timestamp())::text now`,
  );
  return observed.rows[0]?.now;
}
