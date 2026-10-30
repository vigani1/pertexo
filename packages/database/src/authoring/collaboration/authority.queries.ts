import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { CollaborationScope } from './contract.js';
export async function requireCollaborationAuthority(
  client: PoolClient,
  input: CollaborationScope,
  lock: 'share' | 'update' = 'share',
  {
    editing = false,
    browsing = false,
  }: Readonly<{
    editing?: boolean | undefined;
    browsing?: boolean | undefined;
  }> = {},
) {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    browsing,
    roles: rolesForCapability(editing ? 'workflow:update' : 'workflow:read'),
    resource: {
      workflowId: input.workflowId,
      capability: editing ? 'workflow:update' : 'workflow:read',
    },
  });
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
}
