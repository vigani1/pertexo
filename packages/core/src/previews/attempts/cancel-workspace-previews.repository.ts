import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { UNFINISHED_PREVIEW_STATUSES } from '../state.js';
import { appendPreviewTerminalFacts } from './facts.repository.js';

/** Caller holds the workspace exclusively; dispatched effects keep their outcome. */
export async function cancelUndispatchedWorkspacePreviews(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const db = drizzle(client);
  const pending = await db
    .select({ id: previewAttempts.id, runId: previewAttempts.previewRunId })
    .from(previewAttempts)
    .where(
      and(
        eq(previewAttempts.workspaceId, workspaceId),
        inArray(previewAttempts.status, UNFINISHED_PREVIEW_STATUSES),
        isNull(previewAttempts.dispatchMarkedAt),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  for (const attempt of pending) {
    await db
      .update(previewAttempts)
      .set({
        status: 'canceled',
        safeErrorCode: 'workspace.pending_deletion',
        startedAt: sql`coalesce(${previewAttempts.startedAt},clock_timestamp())`,
        completedAt: sql`clock_timestamp()`,
        leaseOwner: null,
        leaseExpiresAt: null,
        fenceToken: sql`${previewAttempts.fenceToken}+1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(previewAttempts.workspaceId, workspaceId),
          eq(previewAttempts.id, attempt.id),
        ),
      )
      .catch(rethrowQueryFailure);
    await db
      .update(previewRuns)
      .set({
        status: 'canceled',
        safeErrorCode: 'workspace.pending_deletion',
        startedAt: sql`coalesce(${previewRuns.startedAt},clock_timestamp())`,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(previewRuns.workspaceId, workspaceId),
          eq(previewRuns.id, attempt.runId),
        ),
      )
      .catch(rethrowQueryFailure);
    await appendPreviewTerminalFacts(client, {
      workspaceId,
      previewAttemptId: attempt.id,
      previewRunId: attempt.runId,
      status: 'canceled',
    });
  }
}
