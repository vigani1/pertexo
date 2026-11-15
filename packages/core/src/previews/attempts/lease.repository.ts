import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';

import { SECOND_INTERVAL } from '../../shared/sql-intervals.repository.js';
import { UNFINISHED_PREVIEW_STATUSES } from '../preview-state.js';

type AttemptScope = Readonly<{
  previewAttemptId: string;
  previewRunId: string;
  workspaceId: string;
}>;

/** A lease runs for its duration, but never past the run's deadline. */
function leaseUntil(leaseDurationSeconds: number) {
  return sql`least(clock_timestamp()+(${leaseDurationSeconds}::int*${SECOND_INTERVAL}),${previewRuns.executionDeadlineAt})`;
}

/**
 * Leases an unfinished attempt to the worker and bumps its fence, unless the
 * run's deadline has passed. Undefined when nothing was leased.
 */
export async function leasePreviewAttempt(
  client: PoolClient,
  scope: AttemptScope &
    Readonly<{ workerId: string; leaseDurationSeconds: number }>,
) {
  const claimed = await drizzle(client)
    .update(previewAttempts)
    .set({
      status: 'running',
      leaseOwner: scope.workerId,
      leaseExpiresAt: leaseUntil(scope.leaseDurationSeconds),
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      startedAt: sql`coalesce(${previewAttempts.startedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(previewRuns)
    .where(
      and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        inArray(previewAttempts.status, UNFINISHED_PREVIEW_STATUSES),
        eq(previewRuns.workspaceId, previewAttempts.workspaceId),
        eq(previewRuns.id, previewAttempts.previewRunId),
        sql`${previewRuns.executionDeadlineAt}>clock_timestamp()`,
      ),
    )
    .returning({
      fenceToken: previewAttempts.fenceToken,
      leaseExpiresAt: sql<Date>`${previewAttempts.leaseExpiresAt}`.mapWith(
        previewAttempts.leaseExpiresAt,
      ),
    })
    .catch(rethrowQueryFailure);
  return claimed[0];
}

/** A queued run starts running with its first lease. */
export async function markPreviewRunStarted(
  client: PoolClient,
  scope: Omit<AttemptScope, 'previewAttemptId'>,
): Promise<void> {
  await drizzle(client)
    .update(previewRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${previewRuns.startedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, scope.workspaceId),
        eq(previewRuns.id, scope.previewRunId),
        eq(previewRuns.status, 'queued'),
      ),
    )
    .catch(rethrowQueryFailure);
}

/**
 * Extends the worker's live lease under its fence, up to the run's deadline.
 * Undefined when the lease was lost.
 */
export async function extendPreviewLease(
  client: PoolClient,
  scope: AttemptScope &
    Readonly<{
      attemptFenceToken: number;
      leaseDurationSeconds: number;
      workerId: string;
    }>,
) {
  const result = await drizzle(client)
    .update(previewAttempts)
    .set({
      leaseExpiresAt: leaseUntil(scope.leaseDurationSeconds),
      updatedAt: sql`clock_timestamp()`,
    })
    .from(previewRuns)
    .where(
      and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        eq(previewAttempts.status, 'running'),
        eq(previewAttempts.leaseOwner, scope.workerId),
        eq(previewAttempts.fenceToken, scope.attemptFenceToken),
        sql`${previewAttempts.leaseExpiresAt}>clock_timestamp()`,
        eq(previewRuns.workspaceId, previewAttempts.workspaceId),
        eq(previewRuns.id, previewAttempts.previewRunId),
        sql`${previewRuns.executionDeadlineAt}>clock_timestamp()`,
      ),
    )
    .returning({
      attemptLeaseExpiresAt:
        sql<Date>`${previewAttempts.leaseExpiresAt}`.mapWith(
          previewAttempts.leaseExpiresAt,
        ),
      runExecutionDeadlineAt: previewRuns.executionDeadlineAt,
    })
    .catch(rethrowQueryFailure);
  return result[0];
}
