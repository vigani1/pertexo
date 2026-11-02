import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import type { AuthoringAccess } from '../workflows/access.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { CollaborationScope } from './contract.js';

export type CollaborationEntry = Readonly<{
  lock?: 'share' | 'update';
  editing?: boolean;
  browsing?: boolean;
}>;

export type EnterCollaboration = ReturnType<typeof createCollaborationEntry>;

/** A discussion needs the workflow, held so it can't be deleted under the writes. */
export function createCollaborationEntry(access: AuthoringAccess) {
  return <T>(
    input: CollaborationScope,
    { lock = 'share', editing = false, browsing = false }: CollaborationEntry,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> =>
    access.workflow(
      input,
      {
        capability: editing ? 'workflow:update' : 'workflow:read',
        ...(browsing ? { statuses: BROWSABLE_WORKSPACE_STATUSES } : {}),
      },
      async (client) => {
        const row = await drizzle(client)
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.workspaceId, input.workspaceId),
              eq(workflows.id, input.workflowId),
            ),
          )
          .for(lock)
          .catch(rethrowQueryFailure);
        if (row.length !== 1)
          throw new WorkflowNotFoundError('Workflow is not visible');
        return work(client);
      },
    );
}
