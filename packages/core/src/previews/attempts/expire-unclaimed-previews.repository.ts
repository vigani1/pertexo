import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { previewRuns, previewAttempts } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import { isStoredDataError } from '../../shared/stored-values.js';
import { loadPreviewLease } from './preview-claim.repository.js';
import { appendPreviewTerminalFacts } from './facts.repository.js';
import { UNFINISHED_PREVIEW_STATUSES } from '../preview-state.js';

/** Maintenance decides expired work even when no delivery ever claimed it. */
export async function expireUnclaimedPreview(client: PoolClient) {
  const db = drizzle(client);
  const due = and(
    eq(previewAttempts.status, 'queued'),
    isNull(previewAttempts.dispatchMarkedAt),
    inArray(previewRuns.status, UNFINISHED_PREVIEW_STATUSES),
    lte(previewRuns.executionDeadlineAt, sql`clock_timestamp()`),
  );
  const candidates = () =>
    db
      .select({
        previewRunId: previewRuns.id,
        previewAttemptId: previewAttempts.id,
        workspaceId: previewRuns.workspaceId,
        attemptFenceToken: previewAttempts.fenceToken,
      })
      .from(previewRuns)
      .innerJoin(
        previewAttempts,
        and(
          eq(previewAttempts.workspaceId, previewRuns.workspaceId),
          eq(previewAttempts.previewRunId, previewRuns.id),
        ),
      );
  const [candidate] = await candidates()
    .where(due)
    .orderBy(asc(previewRuns.executionDeadlineAt), asc(previewRuns.id))
    .limit(1)
    .catch(rethrowQueryFailure);
  if (candidate === undefined) return undefined;
  await db
    .execute(
      sql`select set_config('app.workspace_id',${candidate.workspaceId},true)`,
    )
    .catch(rethrowQueryFailure);
  // Lifecycle, worker claims and purge take the workspace before preview rows.
  await lockWorkspaceRunAdmission(db, candidate.workspaceId);
  const [locked] = await candidates()
    .where(and(due, eq(previewRuns.id, candidate.previewRunId)))
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  if (locked === undefined) return undefined;
  let status: 'timed_out' | 'failed' = 'timed_out';
  let safeErrorCode = 'preview.deadline_exceeded';
  try {
    await loadPreviewLease(client, locked);
  } catch (error: unknown) {
    if (!isStoredDataError(error)) throw error;
    status = 'failed';
    safeErrorCode = 'preview.stored_data_invalid';
  }
  await db
    .update(previewAttempts)
    .set({
      status,
      safeErrorCode,
      errorSummary:
        status === 'failed'
          ? 'Saved step test data could not be read. Test the step again.'
          : null,
      startedAt: sql`coalesce(${previewAttempts.startedAt},clock_timestamp())`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewAttempts.workspaceId, locked.workspaceId),
        eq(previewAttempts.id, locked.previewAttemptId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(previewRuns)
    .set({
      status,
      safeErrorCode,
      startedAt: sql`coalesce(${previewRuns.startedAt},clock_timestamp())`,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, locked.workspaceId),
        eq(previewRuns.id, locked.previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  await appendPreviewTerminalFacts(client, { ...locked, status });
  return {
    workspaceId: locked.workspaceId,
    previewRunId: locked.previewRunId,
    status: 'progressed' as const,
  };
}
