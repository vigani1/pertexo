import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';

import { lockActiveTriggerWorkflow } from './reconciliation/activation.repository.js';
import { withWorkflowAccess } from './workflow-access.js';

/**
 * A configuration change: authority, then the workflow's row, then any configuration
 * row. Every trigger change takes them in this order.
 */
export function withTriggerManagement<T>(
  pool: Pool,
  {
    workspaceId,
    actorId,
    workflowId,
    triggerId,
  }: Readonly<{
    workspaceId: string;
    actorId: string;
    workflowId: string;
    triggerId: string;
  }>,
  denied: () => Error,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkflowAccess(
    pool,
    { workspaceId, actorId, workflowId },
    {
      mode: 'change',
      capability: 'workflow:update',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:update',
      denied,
    },
    async (client) => {
      if (
        !(await lockActiveTriggerWorkflow(
          client,
          workspaceId,
          triggerId,
          workflowId,
        ))
      )
        throw denied();
      return work(client);
    },
  );
}
