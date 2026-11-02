import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowDrafts, workflows } from '@pertexo/database/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { WorkflowRef } from '../access.js';
import { WorkflowNotFoundError } from '../errors.js';
import { draftProjection } from '../representation/records.queries.js';

/**
 * The workflow and then its draft, in that order everywhere a command takes both:
 * publication, restoring a version and duplicating a draft. An archived workflow
 * is read-only, so it reads as missing.
 */
export async function lockActiveWorkflow(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
): Promise<void> {
  const [workflow] = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (workflow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

export async function lockDraft(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
) {
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}
