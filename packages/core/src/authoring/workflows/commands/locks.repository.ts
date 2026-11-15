import type { WorkflowRef } from '../../../shared/workflow-actor.types.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowDrafts, workflows } from '@pertexo/database/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  draftProjection,
  workflowProjection,
} from '../representation/workflow-representations.repository.js';

/**
 * The workflow and then its draft, in that order everywhere a command takes both:
 * publication, restoring a version and duplicating a draft. An archived workflow
 * is read-only, so it reads as missing.
 */
export async function lockActiveWorkflowRow(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
): Promise<boolean> {
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
  if (workflow === undefined) return false;
  return true;
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

/**
 * The workflow row under an update lock, as a revision-checked command reads
 * it; `active` reads an archived workflow as missing.
 */
export async function lockWorkflowRecord(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
  { active }: Readonly<{ active: boolean }>,
) {
  const [row] = await drizzle(client)
    .select(workflowProjection)
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.id, workflowId),
        active ? eq(workflows.lifecycleStatus, 'active') : undefined,
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}

/** The source of a duplicate, locked before its draft; undefined when missing. */
export async function lockWorkflowLifecycleStatus(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
) {
  const [row] = await drizzle(client)
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return row?.lifecycleStatus;
}

/** A replay holds the workflow it answers about under a share lock. */
export async function shareLockWorkflow(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
): Promise<boolean> {
  const rows = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return rows.length === 1;
}
