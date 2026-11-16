import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowDrafts,
  workflowOrganizationState,
  workflows,
  workflowTemplateOrigins,
} from '@pertexo/database/schema';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { WorkflowRef } from '../../../shared/access/workflow-actor.types.js';
import {
  draftProjection,
  workflowProjection,
} from '../representation/workflow-representations.repository.js';

/**
 * A new active, inactive workflow at draft revision 1, in its folder when it
 * has one: the rows creating and duplicating a workflow both write.
 */
export async function insertNewWorkflow(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    name: string;
    actorId: string;
    folderId: string | null | undefined;
    graph: WorkflowGraph;
  }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .insert(workflows)
    .values({
      id: input.workflowId,
      workspaceId: input.workspaceId,
      name: input.name,
      lifecycleStatus: 'active',
      activationStatus: 'inactive',
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
  if (input.folderId != null)
    await db
      .insert(workflowOrganizationState)
      .values({
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        folderId: input.folderId,
        revision: 1,
      })
      .catch(rethrowQueryFailure);
  await db
    .insert(workflowDrafts)
    .values({
      workflowId: input.workflowId,
      workspaceId: input.workspaceId,
      revision: 1,
      graphJson: sql`${JSON.stringify(input.graph)}::json`,
      updatedBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
}

/** A duplicate inherits its source's template origin, marked as inherited. */
export async function inheritTemplateOrigin(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    sourceWorkflowId: string;
    destinationId: string;
  }>,
): Promise<void> {
  const db = drizzle(client);
  const origin = db
    .select({
      workspaceId: workflowTemplateOrigins.workspaceId,
      workflowId: sql<string>`${input.destinationId}::uuid`.as('workflow_id'),
      origin:
        sql`${workflowTemplateOrigins.origin}||'{"derivation":"inherited"}'::jsonb`.as(
          'origin',
        ),
    })
    .from(workflowTemplateOrigins)
    .where(
      and(
        eq(workflowTemplateOrigins.workspaceId, input.workspaceId),
        eq(workflowTemplateOrigins.workflowId, input.sourceWorkflowId),
      ),
    );
  await db
    .insert(workflowTemplateOrigins)
    .select(origin)
    .catch(rethrowQueryFailure);
}

/** The workflow and its draft, as a create command answers with them. */
export async function readWorkflowWithDraft(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
) {
  const [row] = await drizzle(client)
    .select({ workflow: workflowProjection, draft: draftProjection })
    .from(workflows)
    .innerJoin(
      workflowDrafts,
      and(
        eq(workflowDrafts.workspaceId, workflows.workspaceId),
        eq(workflowDrafts.workflowId, workflows.id),
      ),
    )
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  return row;
}
