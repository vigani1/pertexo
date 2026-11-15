import {
  previewAttempts,
  previewRuns,
  idempotencyRecords,
  artifactLinks,
  artifacts as artifactRecords,
} from '@pertexo/database/schema';
import {
  and,
  asc,
  eq,
  exists,
  getTableName,
  lte,
  ne,
  notExists,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

type PreviewTarget = Readonly<{ previewRunId: string; workspaceId: string }>;

/** Locks the next finished, expired preview that no later preview builds on. */
export async function claimExpiredPreview(
  client: PoolClient,
): Promise<Readonly<{ id: string; workspaceId: string }> | undefined> {
  const db = drizzle(client),
    child = alias(previewRuns, 'child');
  const [preview] = await db
    .select({ id: previewRuns.id, workspaceId: previewRuns.workspaceId })
    .from(previewRuns)
    .where(
      and(
        lte(previewRuns.expiresAt, sql`clock_timestamp()`),
        sql`${previewRuns.status} in ('succeeded','failed','canceled','timed_out','outcome_unknown')`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(child)
            .where(
              and(
                eq(child.workspaceId, previewRuns.workspaceId),
                eq(child.priorPreviewRunId, previewRuns.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(previewRuns.expiresAt), asc(previewRuns.id))
    .limit(1)
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  return preview;
}

/**
 * Locks the preview's first artifact not yet deleted, and says whether it
 * has been left alone for the quiescence period.
 */
export async function lockPreviewArtifact(
  client: PoolClient,
  { previewRunId, workspaceId }: PreviewTarget,
  quiescenceSeconds: number,
) {
  const [artifact] = await drizzle(client)
    .select({
      id: artifactRecords.id,
      status: artifactRecords.status,
      quiet: sql<boolean>`${artifactRecords.updatedAt}<=clock_timestamp()-make_interval(secs=>${quiescenceSeconds})`,
    })
    .from(artifactLinks)
    .innerJoin(
      artifactRecords,
      and(
        eq(artifactRecords.workspaceId, artifactLinks.workspaceId),
        eq(artifactRecords.id, artifactLinks.artifactId),
      ),
    )
    .where(
      and(
        eq(artifactLinks.workspaceId, workspaceId),
        eq(artifactLinks.ownerKind, 'preview_run'),
        eq(artifactLinks.ownerId, previewRunId),
        ne(artifactRecords.status, 'deleted'),
      ),
    )
    .orderBy(asc(artifactRecords.id))
    .limit(1)
    .for('update', {
      of: alias(artifactRecords, getTableName(artifactRecords)),
    })
    .catch(rethrowQueryFailure);
  return artifact;
}

/** Starts a preview artifact's deletion; its uploads get time to finish. */
export async function markPreviewArtifactDeleting(
  client: PoolClient,
  artifactId: string,
): Promise<void> {
  await drizzle(client)
    .update(artifactRecords)
    .set({ status: 'deleting', updatedAt: sql`clock_timestamp()` })
    .where(eq(artifactRecords.id, artifactId))
    .catch(rethrowQueryFailure);
}

/** Records that a deleting artifact's bytes are gone. */
export async function markPreviewArtifactDeleted(
  client: PoolClient,
  artifactId: string,
): Promise<void> {
  await drizzle(client)
    .update(artifactRecords)
    .set({
      status: 'deleted',
      deletedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifactRecords.id, artifactId),
        eq(artifactRecords.status, 'deleting'),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Whether any of the preview's artifacts is not yet deleted. */
export async function hasUndeletedPreviewArtifacts(
  client: PoolClient,
  { previewRunId, workspaceId }: PreviewTarget,
): Promise<boolean> {
  const remaining = await drizzle(client)
    .select({ one: sql`1` })
    .from(artifactLinks)
    .innerJoin(
      artifactRecords,
      and(
        eq(artifactRecords.workspaceId, artifactLinks.workspaceId),
        eq(artifactRecords.id, artifactLinks.artifactId),
      ),
    )
    .where(
      and(
        eq(artifactLinks.workspaceId, workspaceId),
        eq(artifactLinks.ownerKind, 'preview_run'),
        eq(artifactLinks.ownerId, previewRunId),
        ne(artifactRecords.status, 'deleted'),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return remaining.length !== 0;
}

/** Deletes a preview whose artifacts are all gone, with its attempts. */
export async function removePreview(
  client: PoolClient,
  workspaceId: string,
  previewRunId: string,
): Promise<void> {
  const db = drizzle(client);
  const links = db.$with('links').as(
    db
      .delete(artifactLinks)
      .where(
        and(
          eq(artifactLinks.workspaceId, workspaceId),
          eq(artifactLinks.ownerKind, 'preview_run'),
          eq(artifactLinks.ownerId, previewRunId),
        ),
      )
      .returning({ artifactId: artifactLinks.artifactId }),
  );
  await db
    .with(links)
    .delete(artifactRecords)
    .where(
      and(
        eq(artifactRecords.workspaceId, workspaceId),
        eq(artifactRecords.status, 'deleted'),
        exists(
          db
            .select({ one: sql`1` })
            .from(links)
            .where(eq(links.artifactId, artifactRecords.id)),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(previewAttempts)
    .where(
      and(
        eq(previewAttempts.workspaceId, workspaceId),
        eq(previewAttempts.previewRunId, previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.workspaceId, workspaceId),
        eq(idempotencyRecords.operation, 'preview.execute'),
        eq(idempotencyRecords.resourceId, previewRunId),
        lte(idempotencyRecords.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, workspaceId),
        eq(previewRuns.id, previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
}
