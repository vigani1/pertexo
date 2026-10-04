import type { Pool, PoolClient } from 'pg';

import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/workspace.js';

export function assertCoordinatorNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export function withCoordinatorReadClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
  nativeControlReadTimeoutMillis?: number,
): Promise<T> {
  assertCoordinatorNotAborted(signal);
  return withTenantScopedReadClient(pool, { workspaceId }, operation, {
    signal,
    ...(nativeControlReadTimeoutMillis === undefined
      ? {}
      : {
          nativeReadBudget: {
            readTimeoutMillis: nativeControlReadTimeoutMillis,
            controlReadTimeoutMillis: nativeControlReadTimeoutMillis,
          },
        }),
  });
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
      await client.query(
        "select set_config('app.workflow_concurrency_protocol','1',true)",
      );
      // Lifecycle/purge holds workspace before run rows. Acquire the shared
      // workspace lock before any coordinator run/checkpoint lock or FK write.
      await client.query('select app.lock_workspace_run_admission($1)', [
        workspaceId,
      ]);
      return operation(client);
    },
    { signal },
  );
}
