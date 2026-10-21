import type { PoolClient } from 'pg';
import { WorkspaceAccessDeniedError } from '../errors.js';
import { rolesForCapability, type Role } from '../policy.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../workspaces/authority.js';
import type { ResourceActor, WorkflowResourceCapability } from './contract.js';
import { readFolderScope } from './facts.js';
import { workflowAccessible } from './workflows.js';

/** Commands stabilize current grants through the workspace-first authority fence. */
export async function authorizeWorkflowResource(
  client: PoolClient,
  input: ResourceActor & Readonly<{ workflowId: string }>,
  capability: WorkflowResourceCapability,
  locking: boolean,
  roles: readonly Role[] = rolesForCapability(capability),
): Promise<boolean> {
  try {
    const role = await (
      locking ? lockWorkspaceAuthority : readWorkspaceAuthority
    )(client, input.workspaceId, input.actorId, roles);
    return await workflowAccessible(
      client,
      await readFolderScope(client, input, role),
      input.workspaceId,
      input.workflowId,
      capability,
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError) return false;
    throw error;
  }
}
