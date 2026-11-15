import { and, eq, inArray, isNotNull, isNull, sql, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { artifacts, formUploads } from '@pertexo/database/schema';

/**
 * The bytes of public-link uploads not yet sent with a form, read after the
 * workspace's unsent-upload lock so concurrent begins see each other.
 */
export async function lockUnsentPublicBytes(
  client: PoolClient,
  workspaceId: string,
): Promise<number> {
  const db = drizzle(client);
  await db
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`unsent-public-form-uploads:${workspaceId}`},0))`,
    )
    .catch(rethrowQueryFailure);
  const [held] = await db
    .select({ bytes: sum(artifacts.byteLength).mapWith(Number) })
    .from(formUploads)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.workspaceId, formUploads.workspaceId),
        eq(artifacts.id, formUploads.artifactId),
      ),
    )
    .where(
      and(
        eq(formUploads.workspaceId, workspaceId),
        isNotNull(formUploads.capabilityHash),
        isNull(formUploads.submittedAt),
        inArray(artifacts.status, ['pending', 'available']),
        sql`${artifacts.expiresAt}>clock_timestamp()`,
      ),
    )
    .catch(rethrowQueryFailure);
  return held?.bytes ?? 0;
}

/** A sent form's files stop counting as unsent; its run keeps them. */
export async function markFormUploadsSubmitted(
  client: PoolClient,
  workspaceId: string,
  uploadIds: readonly string[],
): Promise<void> {
  if (uploadIds.length === 0) return;
  await drizzle(client)
    .update(formUploads)
    .set({ submittedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(formUploads.workspaceId, workspaceId),
        inArray(formUploads.artifactId, [...uploadIds]),
        isNull(formUploads.submittedAt),
      ),
    )
    .catch(rethrowQueryFailure);
}
