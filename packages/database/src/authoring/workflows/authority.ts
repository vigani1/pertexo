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
): Promise<void> {
  try {
    await lockWorkspaceAuthority(client, workspaceId, actorId, roles);
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkflowNotFoundError('Workflow is not visible');
    throw error;
  }
}
