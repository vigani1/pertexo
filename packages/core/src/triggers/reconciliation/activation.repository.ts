import { and, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowTriggers,
  triggerSchedules,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/** Acquire workflow authority before any configuration row is locked. */
export async function lockActiveTriggerWorkflow(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
  expectedWorkflowId?: string,
): Promise<boolean> {
  const workflow = alias(workflows, 'workflow');
  const result = await drizzle(client)
    .select({ id: workflow.id })
    .from(workflow)
    .innerJoin(
      workflowTriggers,
      and(
        eq(workflowTriggers.workspaceId, workflow.workspaceId),
        eq(workflowTriggers.workflowId, workflow.id),
        eq(workflowTriggers.workflowVersionId, workflow.publishedVersionId),
      ),
    )
    .where(
      and(
        eq(workflow.workspaceId, workspaceId),
        eq(workflowTriggers.id, triggerId),
        eq(workflow.lifecycleStatus, 'active'),
        sql`(${expectedWorkflowId ?? null}::uuid is null or ${workflow.id}=${expectedWorkflowId ?? null})`,
      ),
    )
    .for('update', { of: workflow })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}

/** Pause effective admission without restoring or discarding configuration. */
export async function deactivateArchivedWorkflowTriggers(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(workflowTriggers)
    .set({
      status: 'disabled',
      healthStatus: 'disabled',
      lastErrorCode: null,
      reconciledAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  const matching = db
    .select({ one: sql`1` })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, triggerSchedules.workspaceId),
        eq(workflowTriggers.id, triggerSchedules.triggerId),
        eq(workflowTriggers.workflowId, workflowId),
      ),
    );
  await db
    .update(triggerSchedules)
    .set({
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(triggerSchedules.workspaceId, workspaceId), exists(matching)))
    .catch(rethrowQueryFailure);
}
