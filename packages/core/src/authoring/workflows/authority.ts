import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import type { WorkflowResourceCapability } from '../../tenant-access/resources/contract.js';
import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/workflow-model';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import {
  lockBrowsableWorkspaceAuthority,
  lockWorkspaceAuthority,
} from '../../shared/authority.queries.js';
import { WorkflowNotFoundError } from './errors.js';

/** Preserve authoring's non-disclosure contract at the shared authority fence. */
export async function lockWorkflowAuthoringAuthority(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    roles,
    resource,
    browsing = false,
  }: Readonly<{
    actorId: string;
    roles: readonly Role[];
    /** A read a suspended workspace still allows (ADR 013/027). */
    browsing?: boolean | undefined;
    resource?:
      | Readonly<{
          workflowId: string;
          capability: WorkflowResourceCapability;
        }>
      | undefined;
  }>,
): Promise<void> {
  try {
    const role = await (
      browsing ? lockBrowsableWorkspaceAuthority : lockWorkspaceAuthority
    )(client, workspaceId, actorId, roles);
    if (resource !== undefined) {
      const access = await readFolderScope(
        client,
        { workspaceId, actorId },
        role,
      );
      if (
        !(await workflowAccessible(client, access, {
          workspaceId,
          workflowId: resource.workflowId,
          capability: resource.capability,
        }))
      )
        throw new WorkflowNotFoundError('Workflow is not visible');
    }
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkflowNotFoundError('Workflow is not visible');
    throw error;
  }
}
