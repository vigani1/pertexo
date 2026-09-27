import type { Pool, PoolClient } from 'pg';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';

import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/workspace.js';

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
  return encodeWorkflowInvocationKeyV2({
    workflowVersionId: input.workflowVersionId,
    nodeId: input.nodeId,
    ...(input.iterationPath === undefined
      ? {}
      : { iterationPath: input.iterationPath }),
    ...(input.branchPath === undefined
      ? {}
      : {
          branchPath: input.branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
        }),
  });
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
