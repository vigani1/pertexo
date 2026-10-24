import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';

import { withTenantScopedClient } from '../../tenant-access/transactions.js';

export function assertCoordinatorNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export function withCoordinatorWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertCoordinatorNotAborted(signal);
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      await drizzle(client)
        .execute(
          sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
        )
        .catch(rethrowQueryFailure);
      // Lifecycle/purge holds workspace before run rows. Acquire the shared
      // workspace lock before any coordinator run/checkpoint lock or FK write.
      await drizzle(client)
        .execute(sql`select app.lock_workspace_run_admission(${workspaceId})`)
        .catch(rethrowQueryFailure);
      return operation(client);
    },
    { signal },
  );
}
