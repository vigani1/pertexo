import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import {
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
} from '../../../schema/runs/capacity/entitlements.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../advance/contract.js';
export type PendingTaskAllowance = Readonly<{ count: number; limit: number }>;
/** Caller holds the workspace execution counter lock across admission. */
export async function readPendingTaskAllowance(
  client: PoolClient,
  workspaceId: string,
): Promise<PendingTaskAllowance> {
  const db = drizzle(client),
    current = workspaceExecutionEntitlements,
    version = workspaceExecutionEntitlementVersions,
    task = pendingRunTasks;
  const count = db
    .select({ value: sql<number>`count(*)::int` })
    .from(task)
    .where(
      and(
        eq(task.workspaceId, current.workspaceId),
        isNull(task.consumedAt),
        or(
          inArray(task.status, ['pending', 'prepared']),
          and(
            eq(task.kind, 'callback'),
            isNull(task.nodeRunId),
            eq(task.status, 'submitted'),
          ),
        ),
      ),
    );
  const [row] = await db
    .select({ limit: version.queuedRunLimit, count: sql<number>`(${count})` })
    .from(current)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, current.workspaceId),
        eq(version.version, current.currentVersion),
      ),
    )
    .where(eq(current.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  return row;
}
export function hasPendingTaskCapacity(
  allowance: PendingTaskAllowance,
): boolean {
  return allowance.count < allowance.limit;
}
