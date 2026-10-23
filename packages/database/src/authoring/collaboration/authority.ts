import type { PoolClient } from 'pg';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { CollaborationScope } from './contract.js';
export async function requireCollaborationAuthority(
  client: PoolClient,
  input: CollaborationScope,
  lock: 'share' | 'update' = 'share',
  { editing = false }: Readonly<{ editing?: boolean | undefined }> = {},
) {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability(editing ? 'workflow:update' : 'workflow:read'),
    resource: {
      workflowId: input.workflowId,
      capability: editing ? 'workflow:update' : 'workflow:read',
    },
  });
  const row = await client.query(
    'select id from app.workflows where workspace_id=$1 and id=$2 for ' + lock,
    [input.workspaceId, input.workflowId],
  );
  if (row.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}
