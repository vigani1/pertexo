import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowDrafts, workflows } from '@pertexo/database/schema';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { and, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { WorkflowRef } from '../../../shared/access/workflow-actor.types.js';
import { draftProjection } from '../representation/workflow-representations.repository.js';

/** The draft of an active workflow, without a lock; undefined when missing. */
export async function readActiveDraft(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
) {
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowDrafts.workspaceId),
        eq(workflows.id, workflowDrafts.workflowId),
      ),
    )
    .where(
      and(
        eq(workflowDrafts.workspaceId, workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/**
 * Replaces an active workflow's draft graph at the expected revision and moves
 * the revision on; undefined when the revision moved or the workflow is
 * archived or missing.
 */
export async function replaceDraftGraph(
  client: PoolClient,
  input: WorkflowRef &
    Readonly<{
      expectedRevision: number;
      graph: WorkflowGraph;
      actorId: string;
    }>,
) {
  const db = drizzle(client);
  const visible = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    );
  const [row] = await db
    .update(workflowDrafts)
    .set({
      graphJson: sql`${JSON.stringify(input.graph)}::json`,
      revision: sql`${workflowDrafts.revision}+1`,
      updatedBy: input.actorId,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
        eq(workflowDrafts.revision, input.expectedRevision),
        exists(visible),
      ),
    )
    .returning(draftProjection)
    .catch(rethrowQueryFailure);
  return row;
}
