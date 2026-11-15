import type { PoolClient } from 'pg';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import { WorkflowTagConflictError } from '../workflow-organization.errors.js';
import { tagKeyIsFree, findTag, type TagRow } from './tag-state.repository.js';

export async function readTag(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
): Promise<TagRow> {
  const found = await findTag(client, workspaceId, tagId);
  if (found === undefined)
    throw new WorkflowNotFoundError('Tag is not visible');
  return found;
}

export async function requireFreeKey(
  client: PoolClient,
  workspaceId: string,
  tagKey: string,
  tagId: string | null,
): Promise<void> {
  if (!(await tagKeyIsFree(client, workspaceId, tagKey, tagId)))
    throw new WorkflowTagConflictError('key');
}

export function requireRevision(row: TagRow, expected: number): void {
  if (row.revision !== expected)
    throw new WorkflowTagConflictError('tag_revision');
}
