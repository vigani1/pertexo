import type { PoolClient } from 'pg';
import { WorkspaceAccessDeniedError } from '../errors.js';
import { rolesForCapability, type Role } from '@pertexo/workflow-model';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../workspaces/authority.queries.js';
import type { ResourceActor, WorkflowResourceCapability } from './contract.js';
import { readFolderScope } from './facts.queries.js';
import { workflowAccessible } from './workflows.queries.js';

/** Commands stabilize current grants through the workspace-first authority fence. */
export async function authorizeWorkflowResource(
  client: PoolClient,
  input: ResourceActor & Readonly<{ workflowId: string }>,
  {
    capability,
    locking,
    roles = rolesForCapability(capability),
  }: Readonly<{
    capability: WorkflowResourceCapability;
    locking: boolean;
    roles?: readonly Role[] | undefined;
  }>,
): Promise<boolean> {
  try {
    const role = locking
      ? await lockWorkspaceAuthority(
          client,
          input.workspaceId,
          input.actorId,
          roles,
        )
      : await readWorkspaceAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles,
        });
    return await workflowAccessible(
      client,
      await readFolderScope(client, input, role),
      {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        capability,
      },
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError) return false;
    throw error;
  }
}
