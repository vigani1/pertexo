import type { PoolClient } from 'pg';
import { WorkspaceAccessDeniedError } from '../errors.js';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  rolesForCapability,
  type Role,
} from '@pertexo/workflow-model';
import {
  lockBrowsableWorkspaceAuthority,
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
    browsing = false,
    roles = rolesForCapability(capability),
  }: Readonly<{
    capability: WorkflowResourceCapability;
    locking: boolean;
    /** A read a suspended workspace still allows (ADR 013/027). */
    browsing?: boolean | undefined;
    roles?: readonly Role[] | undefined;
  }>,
): Promise<boolean> {
  try {
    const role = locking
      ? await (
          browsing ? lockBrowsableWorkspaceAuthority : lockWorkspaceAuthority
        )(client, input.workspaceId, input.actorId, roles)
      : await readWorkspaceAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles,
          ...(browsing
            ? { allowedStatuses: BROWSABLE_WORKSPACE_STATUSES }
            : {}),
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
