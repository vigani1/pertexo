import type { Pool, PoolClient } from 'pg';

import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/workspace.js';

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export function scopedInvocationKey(
  input: Readonly<{
    workflowVersionId: string;
    nodeId: string;
    branchPath?: readonly Readonly<{ nodeId: string; outputPort: string }>[];
    iterationPath?: readonly Readonly<{
      loopNodeId: string;
      ordinal: number;
    }>[];
  }>,
): string {
  const branches = (input.branchPath ?? [])
    .map(({ nodeId, outputPort }) => `${nodeId}:${outputPort}`)
    .join('/');
  const iterations = (input.iterationPath ?? [])
    .map(({ loopNodeId, ordinal }) => `${loopNodeId}:${String(ordinal)}`)
    .join('/');
  return `${encodeURIComponent(input.workflowVersionId)}|${encodeURIComponent(input.nodeId)}|b:${encodeURIComponent(branches)}|i:${encodeURIComponent(iterations)}`;
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
