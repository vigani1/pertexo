import type { WorkflowFolderRecord } from './workflow-folder.types.js';
import type { PoolClient } from 'pg';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import { WorkflowFolderConflictError } from '../workflow-organization.errors.js';
import {
  folderNameIsFree,
  findFolder,
  readFolderDepth,
} from './hierarchy.repository.js';
import type { FolderRow } from './hierarchy.repository.js';

export function requireRevision(row: FolderRow, expected: number): void {
  if (row.revision !== expected)
    throw new WorkflowFolderConflictError('revision');
}

export async function folderDepth(
  client: PoolClient,
  workspaceId: string,
  folderId: string | null,
): Promise<number> {
  if (folderId === null) return 0;
  const depth = await readFolderDepth(client, workspaceId, folderId);
  if (depth === undefined) throw new WorkflowFolderConflictError('hierarchy');
  return depth;
}

export async function readFolder(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<FolderRow> {
  const found = await findFolder(client, workspaceId, folderId);
  if (found === undefined)
    throw new WorkflowNotFoundError('Folder is not visible');
  return found;
}

export async function requireFreeName(
  client: PoolClient,
  workspaceId: string,
  input: Readonly<{
    parentId: string | null;
    folderName: string;
    folderId: string | null;
  }>,
): Promise<void> {
  if (!(await folderNameIsFree(client, workspaceId, input)))
    throw new WorkflowFolderConflictError('name');
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
