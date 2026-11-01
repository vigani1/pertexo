import type { Pool, PoolClient } from 'pg';

import { readFolderScope } from '../shared/facts.queries.js';
import {
  withWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceActor,
} from '../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../tenant-access/errors.js';
import type { WorkflowResourceCapability } from '../tenant-access/resources/contract.js';
import { workflowAccessible } from '../tenant-access/resources/workflows.queries.js';

/**
 * A member reaching one workflow. The role comes from `capability`, the folder from
 * `folderCapability`, because some reads are limited to editors but only need to see
 * the folder. Being refused either way reads as the area's own "not found", so nobody
 * learns the workflow exists.
 */
export async function withWorkflowAccess<T>(
  pool: Pool,
  actor: WorkspaceActor & Readonly<{ workflowId: string }>,
  {
    folderCapability,
    denied,
    ...access
  }: WorkspaceAccess &
    Readonly<{
      folderCapability: WorkflowResourceCapability;
      denied: () => Error;
    }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const { workspaceId, actorId, workflowId } = actor;
  try {
    return await withWorkspaceAccess(
      pool,
      actor,
      access,
      async (client, role) => {
        const scope = await readFolderScope(
          client,
          { workspaceId, actorId },
          role,
        );
        if (
          !(await workflowAccessible(client, scope, {
            workspaceId,
            workflowId,
            capability: folderCapability,
          }))
        )
          throw denied();
        return work(client);
      },
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError) throw denied();
    throw error;
  }
}
