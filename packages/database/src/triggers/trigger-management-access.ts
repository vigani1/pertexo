import type { PoolClient } from 'pg';
import { z } from 'zod';
import { lockActiveTriggerWorkflow } from './workflow-trigger-activation.js';

/** Configuration changes share actor authority and workflow-first lock order. */
export async function canManageWorkflowTrigger(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorId: string;
    triggerId: string;
    workflowId?: string;
  }>,
): Promise<boolean> {
  const workspaceId = z.uuid().parse(input.workspaceId);
  const actorId = z.uuid().parse(input.actorId);
  const triggerId = z.uuid().parse(input.triggerId);
  const workflowId = z.uuid().optional().parse(input.workflowId);
  const membership = await client.query(
    `select 1 from app.workspace_memberships membership
      join app.workspaces workspace on workspace.id=membership.workspace_id
      join app.users actor on actor.id=membership.user_id
     where membership.workspace_id=$1 and membership.user_id=$2
       and membership.status='active' and membership.role in ('owner','admin','builder')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId],
  );
  if (membership.rowCount !== 1) return false;
  return lockActiveTriggerWorkflow(client, workspaceId, triggerId, workflowId);
}
