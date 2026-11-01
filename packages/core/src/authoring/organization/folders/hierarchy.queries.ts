import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { workflowFolders } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { FOLDER_DEPTH_LIMIT } from '../limits.js';
import type { PoolClient } from 'pg';

import { WorkflowNotFoundError } from '../../workflows/errors.js';

import { WorkflowFolderConflictError } from '../errors.js';

import type { WorkflowFolderRecord } from './contract.js';
import { nameKey } from './input.js';

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

export async function readFolder(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<FolderRow> {
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
  if (row === undefined)
    throw new WorkflowNotFoundError('Folder is not visible');
  return row;
}

/** How many folders deep a folder sits; a top-level folder is 1. */
export async function folderDepth(
  client: PoolClient,
  workspaceId: string,
  folderId: string | null,
): Promise<number> {
  if (folderId === null) return 0;
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
      where ancestors.depth<=${FOLDER_DEPTH_LIMIT}
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
    depth > FOLDER_DEPTH_LIMIT;
  if (invalidAncestry) throw new WorkflowFolderConflictError('hierarchy');
  return depth;
}

export async function requireFreeName(
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
): Promise<void> {
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
  if (taken.length !== 0) throw new WorkflowFolderConflictError('name');
}

export function requireRevision(row: FolderRow, expected: number): void {
  if (row.revision !== expected)
    throw new WorkflowFolderConflictError('revision');
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
