import type { Pool, PoolClient } from 'pg';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/transactions.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '../../tenant-access/policy.js';
import { readWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { WorkflowNotFoundError } from '../../authoring/workflows/errors.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
const capabilities = ['workflow:update', 'run:read', 'run:start'] as const;
const testRoles = rolesForCapability('workflow:update').filter((role) =>
  capabilities.every((capability) =>
    rolesForCapability(capability).includes(role),
  ),
);

export async function lockTestAuthority(
  client: PoolClient,
  input: SampleScope,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(
    client,
    input.workspaceId,
    input.actorId,
    testRoles,
  );
}
export function withTestAuthority<T>(
  pool: Pool,
  input: SampleScope,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      await lockTestAuthority(client, input);
      return work(client);
    },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
}

export function withTestRead<T>(
  pool: Pool,
  input: SampleScope,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      try {
        await readWorkspaceAuthority(
          client,
          input.workspaceId,
          input.actorId,
          testRoles,
        );
      } catch (error) {
        if (error instanceof WorkspaceAccessDeniedError)
          throw new WorkflowNotFoundError('Workflow is not visible');
        throw error;
      }
      return work(client);
    },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      statementTimeoutMillis: 2000,
    },
  );
}
