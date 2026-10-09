import type { Pool, PoolClient } from 'pg';

import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/workspace.js';

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export async function withWorkspaceWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  return withTenantScopedClient(pool, { workspaceId }, operation, { signal });
}

export async function withWorkspaceReadClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  return withTenantScopedReadClient(pool, { workspaceId }, operation, {
    signal,
  });
}
