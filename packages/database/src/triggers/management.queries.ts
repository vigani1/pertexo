import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowTriggers } from '../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../platform/query-errors.js';
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
