import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { workflowFolders } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowFolderRecord } from './workflow-folder.types.js';
import { nameKey } from './folder-receipts.schemas.js';
import { folderDepth } from './hierarchy.js';

export const folderProjection = {
  id: workflowFolders.id,
  name: workflowFolders.name,
  parentId: workflowFolders.parentId,
  revision: workflowFolders.revision,
  accessMode: workflowFolders.accessMode,
};
export type FolderRow = Pick<
  typeof workflowFolders.$inferSelect,
  keyof typeof folderProjection
>;

export async function findFolder(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<FolderRow | undefined> {
  const [row] = await drizzle(client)
    .select(folderProjection)
    .from(workflowFolders)
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        eq(workflowFolders.id, folderId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) return undefined;
  return row;
}

/** How many folders deep a folder sits; a top-level folder is 1. */
/** The folder's depth, or undefined when its ancestry is broken or deeper than allowed. */
export async function readFolderDepth(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<number | undefined> {
  const folder = alias(workflowFolders, 'folder');
  const result = await drizzle(client)
    .execute<{ depth: number | null; rooted: boolean | null }>(
      sql`
    with recursive ancestors as (
      select ${workflowFolders.parentId} parent_id,1 depth from ${workflowFolders}
      where ${workflowFolders.workspaceId}=${workspaceId} and ${workflowFolders.id}=${folderId}
      union all
      select ${folder.parentId},ancestors.depth+1 from ancestors
      join ${workflowFolders} ${sql.identifier('folder')}
        on ${folder.workspaceId}=${workspaceId} and ${folder.id}=ancestors.parent_id
      where ancestors.depth<=${WORKFLOW_FOLDER_LIMITS.depth}
    ) select max(depth)::int depth,bool_or(parent_id is null) rooted from ancestors
  `,
    )
    .catch(rethrowQueryFailure);
  const row = result.rows[0];
  const depth = row?.depth;
  const invalidAncestry =
    !row?.rooted ||
    depth === undefined ||
    depth === null ||
    depth > WORKFLOW_FOLDER_LIMITS.depth;
  return invalidAncestry ? undefined : depth;
}

export async function folderNameIsFree(
  client: PoolClient,
  workspaceId: string,
  {
    parentId,
    folderName,
    folderId,
  }: Readonly<{
    parentId: string | null;
    folderName: string;
    folderId: string | null;
  }>,
): Promise<boolean> {
  const taken = await drizzle(client)
    .select({ id: workflowFolders.id })
    .from(workflowFolders)
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        sql`${workflowFolders.parentId} is not distinct from ${parentId}::uuid`,
        eq(workflowFolders.nameKey, nameKey(folderName)),
        sql`${workflowFolders.id} is distinct from ${folderId}::uuid`,
      ),
    )
    .catch(rethrowQueryFailure);
  if (taken.length !== 0) return false;
  return true;
}

export async function folderRecord(
  client: PoolClient,
  workspaceId: string,
  row: FolderRow,
): Promise<WorkflowFolderRecord> {
  return {
    ...row,
    depth: await folderDepth(client, workspaceId, row.id),
  };
}
