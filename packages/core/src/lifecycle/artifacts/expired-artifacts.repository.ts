import { and, asc, eq, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  artifacts as artifactRecords,
  artifactLinks,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import { artifactReferenceOwnersSql } from '../../artifacts/references/owners.repository.js';
import {
  DAY_INTERVAL,
  MINUTE_INTERVAL,
} from '../../shared/sql-intervals.repository.js';

/** Something still refers to it, so it's looked at again much later. */
const REFERENCED_RETRY = DAY_INTERVAL;
/** Long enough for this worker to erase it; another takes over after that. */
const ERASE_RETRY = MINUTE_INTERVAL;

type ExpiredArtifact = Readonly<{ id: string; workspaceId: string }>;

/** Locks the next expired, unlinked artifact no other worker holds. */
export async function claimExpiredArtifact(
  client: PoolClient,
): Promise<ExpiredArtifact | undefined> {
  const db = drizzle(client);
  const [artifact] = await db
    .select({
      id: artifactRecords.id,
      workspaceId: artifactRecords.workspaceId,
    })
    .from(artifactRecords)
    .where(
      and(
        or(
          and(
            eq(artifactRecords.status, 'pending'),
            lte(artifactRecords.expiresAt, sql`clock_timestamp()`),
          ),
          and(
            eq(artifactRecords.status, 'available'),
            lte(artifactRecords.expiresAt, sql`clock_timestamp()`),
          ),
          eq(artifactRecords.status, 'deleting'),
        ),
        or(
          isNull(artifactRecords.retentionRetryAt),
          lte(artifactRecords.retentionRetryAt, sql`clock_timestamp()`),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(artifactLinks)
            .where(
              and(
                eq(artifactLinks.workspaceId, artifactRecords.workspaceId),
                eq(artifactLinks.artifactId, artifactRecords.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(artifactRecords.expiresAt), asc(artifactRecords.id))
    .limit(1)
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  return artifact;
}

/** Whether a run, preview or other owner still refers to the artifact. */
export async function isArtifactReferenced(
  client: PoolClient,
  artifact: ExpiredArtifact,
): Promise<boolean> {
  const [reference] = await drizzle(client)
    .select({
      referenced: sql<boolean>`(${artifactReferenceOwnersSql(sql`${artifact.workspaceId}`, sql`${artifact.id}`)})`,
    })
    .from(artifactRecords)
    .where(
      and(
        eq(artifactRecords.workspaceId, artifact.workspaceId),
        eq(artifactRecords.id, artifact.id),
      ),
    )
    .catch(rethrowQueryFailure);
  return reference?.referenced ?? false;
}

/** A referenced artifact waits a day before it is looked at again. */
export async function deferReferencedArtifact(
  client: PoolClient,
  artifactId: string,
): Promise<void> {
  await drizzle(client)
    .update(artifactRecords)
    .set({
      retentionRetryAt: sql`clock_timestamp()+${REFERENCED_RETRY}`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(artifactRecords.id, artifactId))
    .catch(rethrowQueryFailure);
}

/** Marks the artifact deleting, held by this worker for the erase retry. */
export async function markArtifactDeleting(
  client: PoolClient,
  artifactId: string,
): Promise<void> {
  await drizzle(client)
    .update(artifactRecords)
    .set({
      status: 'deleting',
      retentionRetryAt: sql`clock_timestamp()+${ERASE_RETRY}`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(artifactRecords.id, artifactId))
    .catch(rethrowQueryFailure);
}

/** Removes a deleting artifact's row once the store no longer has its bytes. */
export async function deleteErasedArtifact(
  client: PoolClient,
  artifactId: string,
): Promise<void> {
  await drizzle(client)
    .delete(artifactRecords)
    .where(
      and(
        eq(artifactRecords.id, artifactId),
        eq(artifactRecords.status, 'deleting'),
      ),
    )
    .catch(rethrowQueryFailure);
}
