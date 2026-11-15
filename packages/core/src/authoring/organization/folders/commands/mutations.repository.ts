import { generatePersistedId } from '@pertexo/database/platform';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias, unionAll } from 'drizzle-orm/pg-core';
import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowFolders,
  workflowOrganizationState,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import { folderProjection } from '../hierarchy.repository.js';
import { nameKey } from '../folder-receipts.schemas.js';

export async function countFolders(
  client: PoolClient,
  workspaceId: string,
): Promise<number> {
  const db = drizzle(client);
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowFolders)
    .where(eq(workflowFolders.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return count?.count ?? 0;
}

export async function insertFolder(
  client: PoolClient,
  workspaceId: string,
  request: Readonly<{ name: string; parentId: string | null }>,
) {
  const db = drizzle(client);
  const [row] = await db
    .insert(workflowFolders)
    .values({
      workspaceId,
      id: generatePersistedId(),
      parentId: request.parentId,
      name: request.name,
      nameKey: nameKey(request.name),
    })
    .returning(folderProjection)
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Folder was not created');
  return row;
}

export async function renameFolderRow(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
  name: string,
) {
  const [renamed] = await drizzle(client)
    .update(workflowFolders)
    .set({
      name: name,
      nameKey: nameKey(name),
      revision: sql`${workflowFolders.revision}+1`,
    })
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .returning(folderProjection)
    .catch(rethrowQueryFailure);
  return renamed;
}

/** The subtree's height, and whether `parentId` lies inside it. */
export async function readSubtree(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
  parentId: string | null,
): Promise<Readonly<{ height?: number; cycle?: boolean }>> {
  const folder = alias(workflowFolders, 'folder');
  const subtree = await drizzle(client)
    .execute<{ height: number; cycle: boolean }>(
      sql`
    with recursive descendants as (
      select ${workflowFolders.id} id,1 height from ${workflowFolders}
      where ${workflowFolders.workspaceId}=${workspaceId} and ${workflowFolders.id}=${folderId}
      union all
      select ${folder.id},descendants.height+1 from descendants
      join ${workflowFolders} ${sql.identifier('folder')}
        on ${folder.workspaceId}=${workspaceId} and ${folder.parentId}=descendants.id
      where descendants.height<=${WORKFLOW_FOLDER_LIMITS.depth}
    ) select max(height)::int height,coalesce(bool_or(id=${parentId}::uuid),false) cycle from descendants
  `,
    )
    .catch(rethrowQueryFailure);
  return subtree.rows[0] ?? {};
}

export async function moveFolderRow(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
  parentId: string | null,
) {
  const [moved] = await drizzle(client)
    .update(workflowFolders)
    .set({
      parentId: parentId,
      revision: sql`${workflowFolders.revision}+1`,
    })
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .returning(folderProjection)
    .catch(rethrowQueryFailure);
  return moved;
}

/** Whether a folder or workflow still sits in the folder. */
export async function folderInUse(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<boolean> {
  const db = drizzle(client);
  const used = await unionAll(
    db
      .select({ id: workflowFolders.id })
      .from(workflowFolders)
      .where(
        and(
          eq(workflowFolders.workspaceId, workspaceId),
          eq(workflowFolders.parentId, folderId),
        ),
      ),
    db
      .select({ id: workflowOrganizationState.workflowId })
      .from(workflowOrganizationState)
      .where(
        and(
          eq(workflowOrganizationState.workspaceId, workspaceId),
          eq(workflowOrganizationState.folderId, folderId),
        ),
      ),
  )
    .limit(1)
    .catch(rethrowQueryFailure);
  return used.length !== 0;
}

export async function deleteFolderRow(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(workflowFolders)
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
}
