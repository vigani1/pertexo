import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflows,
  failureNotificationDestinations as destination,
  workflowFailureNotificationPolicies as policy,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';

import type { SetWorkflowPolicyInput } from '../destinations/notification-destination.types.js';

/** False when the workflow or an enabled destination isn't there. */
export async function saveWorkflowPolicy(
  client: PoolClient,
  input: SetWorkflowPolicyInput,
): Promise<boolean> {
  const db = drizzle(client);
  const excluded = alias(policy, 'excluded');
  const result = await db
    .insert(policy)
    .select(
      db
        .select({
          workspaceId: workflows.workspaceId,
          workflowId: workflows.id,
          destinationId: destination.id,
          updatedBy: sql<string>`${input.actorId}::uuid`.as('updated_by'),
          updatedAt: sql`clock_timestamp()`.as('updated_at'),
        })
        .from(workflows)
        .innerJoin(
          destination,
          and(
            eq(destination.workspaceId, workflows.workspaceId),
            eq(destination.id, input.destinationId),
          ),
        )
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            eq(workflows.id, input.workflowId),
            eq(destination.status, 'enabled'),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: policy.workflowId,
      set: {
        destinationId: sql`${excluded.destinationId}`,
        updatedBy: sql`${excluded.updatedBy}`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({ id: policy.workflowId })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}

/** Whether the workflow exists, holding it so it can't be deleted meanwhile. */
export async function shareLockWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<boolean> {
  const existing = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return existing.length === 1;
}

/** Whether a policy was there to delete. */
export async function deleteWorkflowPolicy(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<boolean> {
  const result = await drizzle(client)
    .delete(policy)
    .where(
      and(
        eq(policy.workspaceId, workspaceId),
        eq(policy.workflowId, workflowId),
      ),
    )
    .returning({ id: policy.workflowId })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}

/** The workflow's chosen destination id, or undefined when the workflow is gone. */
export async function readWorkflowPolicyChoice(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<Readonly<{ destinationId: string | null }> | undefined> {
  const [row] = await drizzle(client)
    .select({ destinationId: policy.destinationId })
    .from(workflows)
    .leftJoin(
      policy,
      and(
        eq(policy.workspaceId, workflows.workspaceId),
        eq(policy.workflowId, workflows.id),
      ),
    )
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  return row;
}
