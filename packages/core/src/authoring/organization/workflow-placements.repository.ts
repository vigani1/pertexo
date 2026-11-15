import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowFolders,
  workflowTags,
  workflowOrganizationState,
  workflowTagAssignments,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { OrganizationActor } from './session.js';
import type { OrganizationChange } from './organize-workflow.js';

export async function folderExists(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
) {
  const folder = await drizzle(client)
    .select({ id: workflowFolders.id })
    .from(workflowFolders)
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
  return folder.length === 1;
}

/** How many of these tags the workspace has. */
export async function countWorkspaceTags(
  client: PoolClient,
  workspaceId: string,
  tagIds: readonly string[],
) {
  const [tags] = await drizzle(client)
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowTags)
    .where(
      and(
        eq(workflowTags.workspaceId, workspaceId),
        inArray(workflowTags.id, tagIds),
      ),
    )
    .catch(rethrowQueryFailure);
  return tags?.count;
}

/** The workflow's lifecycle under an update lock for a change, a share lock for a replay. */
export async function lockWorkflowLifecycle(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    strength: 'update' | 'share';
  }>,
) {
  const [workflow] = await drizzle(client)
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for(input.strength)
    .catch(rethrowQueryFailure);
  return workflow?.lifecycleStatus;
}

/** The workflow's organization revision; none when it was never organized. */
export async function readOrganizationRevision(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const [state] = await drizzle(client)
    .select({ revision: workflowOrganizationState.revision })
    .from(workflowOrganizationState)
    .where(
      and(
        eq(workflowOrganizationState.workspaceId, workspaceId),
        eq(workflowOrganizationState.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return state?.revision;
}

export async function persistPlacement(
  client: PoolClient,
  scope: OrganizationActor,
  {
    workflowId,
    change,
    revision,
  }: Readonly<{
    workflowId: string;
    change: OrganizationChange;
    revision: number;
  }>,
): Promise<void> {
  const db = drizzle(client);
  const assignmentScope = and(
    eq(workflowTagAssignments.workspaceId, scope.workspaceId),
    eq(workflowTagAssignments.workflowId, workflowId),
  );
  if (change.kind === 'replace_tags') {
    await db
      .delete(workflowTagAssignments)
      .where(assignmentScope)
      .catch(rethrowQueryFailure);
    if (change.tagIds.length > 0)
      await db
        .insert(workflowTagAssignments)
        .values(
          change.tagIds.map((tagId) => ({
            workspaceId: scope.workspaceId,
            workflowId,
            tagId,
          })),
        )
        .catch(rethrowQueryFailure);
  } else if (change.kind === 'detach_tag') {
    await db
      .delete(workflowTagAssignments)
      .where(
        and(assignmentScope, eq(workflowTagAssignments.tagId, change.tagId)),
      )
      .catch(rethrowQueryFailure);
  }
  await db
    .insert(workflowOrganizationState)
    .values({
      workspaceId: scope.workspaceId,
      workflowId,
      revision,
      folderId: change.kind === 'move' ? change.folderId : null,
    })
    .onConflictDoUpdate({
      target: [
        workflowOrganizationState.workspaceId,
        workflowOrganizationState.workflowId,
      ],
      set: {
        revision: sql`excluded.revision`,
        ...(change.kind === 'move'
          ? { folderId: sql`excluded.folder_id` }
          : { folderId: workflowOrganizationState.folderId }),
      },
    })
    .catch(rethrowQueryFailure);
}
