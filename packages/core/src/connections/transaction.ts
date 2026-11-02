import { lockWorkspaceRunAdmission } from '../runs/admission-locks.queries.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { withTenantScopedClient } from '@pertexo/database/primitives';

/**
 * For flows that don't answer to a member's current authority, so they stay off
 * `withWorkspaceAccess`: a worker using a credential, a token refresh, the
 * OAuth2 callback, and a test finishing for someone who may have lost access
 * since it started. Each decides for itself what it still allows.
 */
export async function withConnectionTransaction<T>(
  pool: Pool,
  {
    workspaceId,
    actorId,
    signal,
  }: Readonly<{
    workspaceId: string;
    actorId?: string | undefined;
    signal?: AbortSignal | undefined;
  }>,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    actorId === undefined ? { workspaceId } : { workspaceId, actorId },
    async (client) => {
      await lockWorkspaceRunAdmission(drizzle(client), workspaceId);
      return operation(client);
    },
    signal === undefined ? {} : { signal },
  );
}
