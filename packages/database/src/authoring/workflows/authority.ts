import { readFolderScope } from '../../tenant-access/resources/facts.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.js';
import type { WorkflowResourceCapability } from '../../tenant-access/resources/contract.js';
import type { PoolClient } from 'pg';
import type { Role } from '../../tenant-access/policy.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { WorkflowNotFoundError } from './errors.js';

/** Preserve authoring's non-disclosure contract at the shared authority fence. */
export async function lockWorkflowAuthoringAuthority(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  roles: readonly Role[],
  resource?: Readonly<{
    workflowId: string;
    capability: WorkflowResourceCapability;
  }>,
): Promise<void> {
  try {
    const role = await lockWorkspaceAuthority(
      client,
      workspaceId,
      actorId,
      roles,
    );
    if (resource !== undefined) {
      const access = await readFolderScope(
        client,
        { workspaceId, actorId },
        role,
      );
      if (
        !(await workflowAccessible(
          client,
          access,
          workspaceId,
          resource.workflowId,
          resource.capability,
        ))
      )
        throw new WorkflowNotFoundError('Workflow is not visible');
    }
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkflowNotFoundError('Workflow is not visible');
    throw error;
  }
}
