import { WORKFLOW_ORGANIZATION_LIMITS } from '@pertexo/workflow-model';

import { generatePersistedId } from '@pertexo/database/platform';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import {
  workflowOrganizationState,
  workflowTagAssignments,
  workflowTags,
  workflows,
} from '@pertexo/database/schema';

import { tagProjection } from '../tag-state.repository.js';

/** A workflow without an organization row reads as revision 1; its first change writes 2. */
const REVISION_AFTER_FIRST_CHANGE = 2;

/** The tag's assignments in workflow order, one past the cleanup cap so an overfull set shows. */
export async function readTagAssignments(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
) {
  const db = drizzle(client);
  const assigned = await db
    .select({ workflowId: workflowTagAssignments.workflowId })
    .from(workflowTagAssignments)
    .where(
      and(
        eq(workflowTagAssignments.workspaceId, workspaceId),
        eq(workflowTagAssignments.tagId, tagId),
      ),
    )
    .orderBy(asc(workflowTagAssignments.workflowId))
    .limit(WORKFLOW_ORGANIZATION_LIMITS.cleanupItems + 1)
    .catch(rethrowQueryFailure);
  return assigned;
}

/** Locks the workflows, advances each one's revision and deletes the tag with its assignments. */
export async function detachTagFromWorkflows(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
  workflowIds: readonly string[],
): Promise<void> {
  const db = drizzle(client);
  await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        inArray(workflows.id, [...workflowIds]),
      ),
    )
    .orderBy(asc(workflows.id))
    .for('update')
    .catch(rethrowQueryFailure);
  if (workflowIds.length > 0)
    await db
      .insert(workflowOrganizationState)
      .values(
        workflowIds.map((workflowId) => ({
          workspaceId: workspaceId,
          workflowId,
          revision: REVISION_AFTER_FIRST_CHANGE,
        })),
      )
      .onConflictDoUpdate({
        target: [
          workflowOrganizationState.workspaceId,
          workflowOrganizationState.workflowId,
        ],
        set: { revision: sql`${workflowOrganizationState.revision}+1` },
      })
      .catch(rethrowQueryFailure);
  await db
    .delete(workflowTagAssignments)
    .where(
      and(
        eq(workflowTagAssignments.workspaceId, workspaceId),
        eq(workflowTagAssignments.tagId, tagId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(workflowTags)
    .where(
      and(
        eq(workflowTags.workspaceId, workspaceId),
        eq(workflowTags.id, tagId),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function countTags(
  client: PoolClient,
  workspaceId: string,
): Promise<number> {
  const db = drizzle(client);
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowTags)
    .where(eq(workflowTags.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return count?.count ?? 0;
}

export async function insertTag(
  client: PoolClient,
  workspaceId: string,
  key: string,
) {
  const db = drizzle(client);
  const [row] = await db
    .insert(workflowTags)
    .values({ workspaceId, id: generatePersistedId(), key: key })
    .returning(tagProjection)
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Tag was not created');
  return row;
}

export async function renameTagRow(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
  key: string,
) {
  const [renamed] = await drizzle(client)
    .update(workflowTags)
    .set({ key: key, revision: sql`${workflowTags.revision}+1` })
    .where(
      and(
        eq(workflowTags.workspaceId, workspaceId),
        eq(workflowTags.id, tagId),
      ),
    )
    .returning(tagProjection)
    .catch(rethrowQueryFailure);
  return renamed;
}
