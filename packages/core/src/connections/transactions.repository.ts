import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import type { WorkspaceTransactionOptions } from '@pertexo/database/primitives';

export async function withConnectionTransaction<T>(
  pool: Pool,
  workspaceId: string,
  {
    actorId,
    operation,
    options = {},
  }: Readonly<{
    actorId: string | undefined;
    operation: (client: PoolClient, workspaceId: string) => Promise<T>;
    options?: WorkspaceTransactionOptions | undefined;
  }>,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    actorId === undefined ? { workspaceId } : { workspaceId, actorId: actorId },
    async (client) => {
      await drizzle(client)
        .execute(sql`select app.lock_workspace_run_admission(${workspaceId})`)
        .catch(rethrowQueryFailure);
      return operation(client, workspaceId);
    },
    options,
  );
}
