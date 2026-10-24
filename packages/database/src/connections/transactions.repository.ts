import type { Pool, PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import { rethrowQueryFailure } from '../platform/query-errors.js';
import { withTenantScopedClient } from '../tenant-access/transactions.js';
import type { WorkspaceTransactionOptions } from '../tenant-access/transactions.js';

import { uuidSchema, identifierSchema } from './admission.js';

export async function withConnectionTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
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
  const workspaceId = uuidSchema.parse(workspaceIdInput);
  return withTenantScopedClient(
    pool,
    actorId === undefined
      ? { workspaceId }
      : { workspaceId, actorId: identifierSchema.parse(actorId) },
    async (client) => {
      await drizzle(client)
        .execute(sql`select app.lock_workspace_run_admission(${workspaceId})`)
        .catch(rethrowQueryFailure);
      return operation(client, workspaceId);
    },
    options,
  );
}
