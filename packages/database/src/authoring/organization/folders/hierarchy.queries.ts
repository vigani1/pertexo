import { FOLDER_DEPTH_LIMIT } from '../limits.js';
import type { PoolClient } from 'pg';

import { WorkflowNotFoundError } from '../../workflows/errors.js';

import { WorkflowFolderConflictError } from '../errors.js';

import { type WorkflowFolderRecord, nameKey } from './contract.js';

export type FolderRow = Readonly<{
  id: string;
  name: string;
  parent_id: string | null;
  revision: string;
  access_mode: 'workspace' | 'restricted';
}>;

export async function readFolder(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<FolderRow> {
  const result = await client.query<FolderRow>(
    `select id, name, parent_id, revision, access_mode from app.workflow_folders
     where workspace_id = $1 and id = $2`,
    [workspaceId, folderId],
  );
  const row = result.rows[0];
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
  const result = await client.query<{
    depth: number | null;
    rooted: boolean | null;
  }>(
    `with recursive ancestors as (
       select parent_id, 1 depth from app.workflow_folders
       where workspace_id = $1 and id = $2
       union all
       select folder.parent_id, ancestors.depth + 1 from ancestors
       join app.workflow_folders folder
         on folder.workspace_id = $1 and folder.id = ancestors.parent_id
       where ancestors.depth <= $3
     )
     select max(depth)::int depth, bool_or(parent_id is null) rooted from ancestors`,
    [workspaceId, folderId, FOLDER_DEPTH_LIMIT],
  );
  const row = result.rows[0];
  if (!row?.rooted || row.depth === null || row.depth > FOLDER_DEPTH_LIMIT)
    throw new WorkflowFolderConflictError('hierarchy');
  return row.depth;
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
  const taken = await client.query(
    `select 1 from app.workflow_folders
     where workspace_id = $1 and parent_id is not distinct from $2::uuid
       and name_key = $3 and id is distinct from $4::uuid`,
    [workspaceId, parentId, nameKey(folderName), folderId],
  );
  if (taken.rowCount !== 0) throw new WorkflowFolderConflictError('name');
}

export function requireRevision(row: FolderRow, expected: number): void {
  if (Number(row.revision) !== expected)
    throw new WorkflowFolderConflictError('revision');
}

export async function folderRecord(
  client: PoolClient,
  workspaceId: string,
  row: FolderRow,
): Promise<WorkflowFolderRecord> {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    revision: Number(row.revision),
    depth: await folderDepth(client, workspaceId, row.id),
    accessMode: row.access_mode,
  };
}
