import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

/**
 * Organization writes in one workspace run one at a time, so folder and tag
 * limits, the folder hierarchy and emptiness checks see each other's changes.
 */
export async function lockOrganization(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended('workflow-organization:' || ${workspaceId},0))`,
    )
    .catch(rethrowQueryFailure);
}
