import { and, eq, inArray, isNotNull, isNull, sql, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { FORM_FILE_LIMITS } from '@pertexo/workflow-model';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { artifacts, formUploads } from '@pertexo/database/schema';
import { FormUploadLimitError } from './errors.js';

/**
 * Anyone with a public link can upload without ever sending the form, so those
 * files get their own small allowance instead of the whole workspace quota.
 * Begins wait on one workspace lock, so concurrent responders can't overshoot.
 */
export async function assertUnsentPublicRoom(
  client: PoolClient,
  workspaceId: string,
  byteLength: number,
): Promise<void> {
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
  if ((held?.bytes ?? 0) + byteLength > FORM_FILE_LIMITS.unsentPublicBytes)
    throw new FormUploadLimitError('unsent_public');
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
