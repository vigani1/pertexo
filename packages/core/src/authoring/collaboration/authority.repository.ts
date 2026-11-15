import type { PoolClient } from 'pg';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import type { AuthoringAccess } from '../workflows/access.js';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import type { CollaborationScope } from './workflow-collaboration.types.js';
import { lockCollaborationWorkflow } from './collaboration-workflow.repository.js';

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
        if (!(await lockCollaborationWorkflow(client, input, lock)))
          throw new WorkflowNotFoundError('Workflow is not visible');
        return work(client);
      },
    );
}
