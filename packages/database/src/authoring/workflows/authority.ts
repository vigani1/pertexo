import type { PoolClient } from 'pg';
import type { Role } from '../../tenant-access/workspace-policy.js';
import { WorkflowNotFoundError } from './errors.js';

/** Ordered current authority fence shared by authoring writes and organization
 * readers. Call only inside the same tenant transaction as the protected work. */
export async function lockWorkflowAuthoringAuthority(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  roles: readonly Role[],
): Promise<void> {
  const workspace = await client.query(
    `select 1 from app.workspaces where id=$1 and status='active' for share`,
    [workspaceId],
  );
  if (workspace.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const actor = await client.query(
    `select 1 from app.users where id=$1 and status='active' for share`,
    [actorId],
  );
  if (actor.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const membership = await client.query(
    `select 1 from app.workspace_memberships
     where workspace_id=$1 and user_id=$2 and status='active'
       and role=any($3::text[]) for share`,
    [workspaceId, actorId, [...roles]],
  );
  if (membership.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}
