import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { workflowRuns } from '@pertexo/database/schema';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { ACTIVE_RUN_STATUSES } from '../statuses.js';

type CancelRequest = Readonly<{ actorId: string; reason: string | null }>;

/** The workspace's unfinished runs no one asked to cancel yet, locked in id order. */
export async function lockUncanceledActiveRuns(
  transaction: WorkspaceTransaction,
): Promise<readonly string[]> {
  const active = await transaction.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        inArray(workflowRuns.status, ACTIVE_RUN_STATUSES),
        isNull(workflowRuns.cancelRequestedAt),
      ),
    )
    .orderBy(asc(workflowRuns.id))
    .for('update');
  return active.map((row) => row.id);
}

/** Records one cancellation request on each locked run. */
export async function markRunsCancelRequested(
  transaction: WorkspaceTransaction,
  runIds: readonly string[],
  request: CancelRequest,
): Promise<void> {
  await transaction.db
    .update(workflowRuns)
    .set({
      cancelRequestedAt: sql`clock_timestamp()`,
      cancelRequestedBy: request.actorId,
      cancelReason: request.reason,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        inArray(workflowRuns.id, [...runIds]),
      ),
    );
}

/** The run's status and any earlier cancellation request, under an update lock. */
export async function lockRunCancellation(
  transaction: WorkspaceTransaction,
  runId: string,
) {
  const [row] = await transaction.db
    .select({
      cancelReason: workflowRuns.cancelReason,
      cancelRequestedAt: workflowRuns.cancelRequestedAt,
      cancelRequestedBy: workflowRuns.cancelRequestedBy,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .for('update');
  return row;
}

/** Records the request on one locked run; the time it wrote, or undefined when lost. */
export async function markRunCancelRequested(
  transaction: WorkspaceTransaction,
  runId: string,
  request: CancelRequest,
): Promise<Date | undefined> {
  // This write always sets the returned timestamp; the schema supplies its Date decoder.
  const [updated] = await transaction.db
    .update(workflowRuns)
    .set({
      cancelRequestedAt: sql`clock_timestamp()`,
      cancelRequestedBy: request.actorId,
      cancelReason: request.reason,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .returning({
      cancelRequestedAt: sql<Date>`${workflowRuns.cancelRequestedAt}`.mapWith(
        workflowRuns.cancelRequestedAt,
      ),
    });
  return updated === undefined
    ? undefined
    : new Date(updated.cancelRequestedAt);
}
