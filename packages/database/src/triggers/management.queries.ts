import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '../platform/query-errors.js';
import { workflowTriggers } from '../schema/authoring/workflows.js';
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
  const workspaceId = input.workspaceId;
  const actorId = input.actorId;
  const triggerId = input.triggerId;
  const workflowId = input.workflowId;
  const trigger = await drizzle(client)
    .select({ workflowId: workflowTriggers.workflowId })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.id, triggerId),
        sql`(${workflowId ?? null}::uuid is null or ${workflowTriggers.workflowId}=${workflowId ?? null})`,
      ),
    )
    .catch(rethrowQueryFailure);
  const target = trigger[0]?.workflowId;
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
