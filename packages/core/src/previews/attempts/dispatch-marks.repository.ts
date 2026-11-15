import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { previewAttempts } from '@pertexo/database/schema';

type LiveLease = Readonly<{
  attemptFenceToken: number;
  previewAttemptId: string;
  previewRunId: string;
  workerId: string;
  workspaceId: string;
}>;

/** The worker still holds this attempt's unexpired lease under its fence. */
function ownsLiveLease(scope: LiveLease) {
  return and(
    eq(previewAttempts.workspaceId, scope.workspaceId),
    eq(previewAttempts.id, scope.previewAttemptId),
    eq(previewAttempts.previewRunId, scope.previewRunId),
    eq(previewAttempts.status, 'running'),
    eq(previewAttempts.leaseOwner, scope.workerId),
    eq(previewAttempts.fenceToken, scope.attemptFenceToken),
    sql`${previewAttempts.leaseExpiresAt}>clock_timestamp()`,
  );
}

/**
 * Locks the leased attempt and reads its provider dispatch binding: null when
 * none is pinned yet, undefined when the lease is gone.
 */
export async function lockPreviewDispatchBinding(
  client: PoolClient,
  scope: LiveLease,
): Promise<string | null | undefined> {
  const locked = await drizzle(client)
    .select({
      providerDispatchBinding: previewAttempts.providerDispatchBinding,
    })
    .from(previewAttempts)
    .where(ownsLiveLease(scope))
    .for('update')
    .catch(rethrowQueryFailure);
  return locked[0]?.providerDispatchBinding;
}

/**
 * Marks the attempt dispatched once, and pins the binding if none is yet;
 * false when the lease is gone.
 */
export async function markPreviewDispatch(
  client: PoolClient,
  scope: LiveLease,
  providerDispatchBinding: string | undefined,
): Promise<boolean> {
  const result = await drizzle(client)
    .update(previewAttempts)
    .set({
      dispatchMarkedAt: sql`coalesce(${previewAttempts.dispatchMarkedAt},clock_timestamp())`,
      providerDispatchBinding: sql`coalesce(${previewAttempts.providerDispatchBinding},${providerDispatchBinding ?? null})`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(ownsLiveLease(scope))
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}
