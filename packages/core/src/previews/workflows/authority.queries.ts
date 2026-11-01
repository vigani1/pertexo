import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import type { Pool, PoolClient } from 'pg';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { readWorkspaceAuthority } from '../../shared/authority.queries.js';
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
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: testRoles,
    resource: { workflowId: input.workflowId, capability: 'workflow:update' },
  });
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
        const role = await readWorkspaceAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: testRoles,
        });
        const access = await readFolderScope(client, input, role);
        if (
          !(await workflowAccessible(client, access, {
            workspaceId: input.workspaceId,
            workflowId: input.workflowId,
          }))
        )
          throw new WorkflowNotFoundError('Workflow is not visible');
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
