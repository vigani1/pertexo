import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';

import {
  UNFINISHED_PREVIEW_STATUSES,
  type PREVIEW_STATUS,
} from '../preview-state.js';
import type { PreviewReconciliationScope } from './preview-reconciliation.types.js';

type ClosedStatus =
  typeof PREVIEW_STATUS.outcomeUnknown | typeof PREVIEW_STATUS.timedOut;
type Closure = Readonly<{
  status: ClosedStatus;
  safeErrorCode: string;
  reconciliationRef: string;
}>;

/** The running attempt under this fence, as the wake-up saw it. */
function fencedRunningAttempt(scope: PreviewReconciliationScope) {
  return and(
    eq(previewAttempts.workspaceId, scope.workspaceId),
    eq(previewAttempts.id, scope.previewAttemptId),
    eq(previewAttempts.previewRunId, scope.previewRunId),
    eq(previewAttempts.status, 'running'),
    eq(previewAttempts.fenceToken, scope.attemptFenceToken),
  );
}

/** Closes the fenced attempt with its final status; false if it moved on. */
export async function closeExpiredAttempt(
  client: PoolClient,
  scope: PreviewReconciliationScope,
  { status, safeErrorCode, reconciliationRef }: Closure,
): Promise<boolean> {
  const attempt = await drizzle(client)
    .update(previewAttempts)
    .set({
      status,
      safeErrorCode,
      reconciliationRef: sql`${reconciliationRef}::jsonb`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(fencedRunningAttempt(scope))
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  return attempt.length === 1;
}

/** Closes the unfinished run with the attempt's final status; false if it had finished. */
export async function closeExpiredRun(
  client: PoolClient,
  scope: PreviewReconciliationScope,
  { status, safeErrorCode }: Omit<Closure, 'reconciliationRef'>,
): Promise<boolean> {
  const run = await drizzle(client)
    .update(previewRuns)
    .set({
      status,
      safeErrorCode,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, scope.workspaceId),
        eq(previewRuns.id, scope.previewRunId),
        inArray(previewRuns.status, UNFINISHED_PREVIEW_STATUSES),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  return run.length === 1;
}

/** Fences the expired owner and queues the attempt again; false if it moved on. */
export async function requeueExpiredAttempt(
  client: PoolClient,
  scope: PreviewReconciliationScope,
  reconciliationRef: string,
): Promise<boolean> {
  const reclaimed = await drizzle(client)
    .update(previewAttempts)
    .set({
      status: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      reconciliationRef: sql`${reconciliationRef}::jsonb`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(fencedRunningAttempt(scope))
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  return reclaimed.length === 1;
}

/** Puts the running run back in the queue; false if it was not running. */
export async function requeuePreviewRun(
  client: PoolClient,
  scope: PreviewReconciliationScope,
): Promise<boolean> {
  const queuedRun = await drizzle(client)
    .update(previewRuns)
    .set({ status: 'queued', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(previewRuns.workspaceId, scope.workspaceId),
        eq(previewRuns.id, scope.previewRunId),
        eq(previewRuns.status, 'running'),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  return queuedRun.length === 1;
}
