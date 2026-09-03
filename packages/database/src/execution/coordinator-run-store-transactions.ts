import type { Pool, PoolClient } from 'pg';

import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/workspace.js';

export function assertCoordinatorNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export function withCoordinatorReadClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertCoordinatorNotAborted(signal);
  return withTenantScopedReadClient(pool, { workspaceId }, operation, {
    signal,
  });
}

export function withCoordinatorWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertCoordinatorNotAborted(signal);
  return withTenantScopedClient(pool, { workspaceId }, operation, { signal });
}
