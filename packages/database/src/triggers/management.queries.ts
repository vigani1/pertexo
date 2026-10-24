import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authorizeWorkflowResource } from '../tenant-access/resources/authority.js';
import { lockActiveTriggerWorkflow } from './reconciliation/activation.repository.js';

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
  const trigger = await client.query<{ workflow_id: string }>(
    `select workflow_id from app.workflow_triggers where workspace_id=$1 and id=$2
      and ($3::uuid is null or workflow_id=$3)`,
    [workspaceId, triggerId, workflowId ?? null],
  );
  const target = trigger.rows[0]?.workflow_id;
  if (
    target === undefined ||
    !(await authorizeWorkflowResource(
      client,
      { workspaceId, actorId, workflowId: target },
      { capability: 'workflow:update', locking: true },
    ))
  )
    return false;
  return lockActiveTriggerWorkflow(client, workspaceId, triggerId, workflowId);
}
