import type { PoolClient } from 'pg';
import { z } from 'zod';

import { WorkflowNotFoundError } from '../../workflows/errors.js';

import { WorkflowTagConflictError } from '../errors.js';

import {
  type PageInput,
  type WorkflowTagRecord,
  type Page,
  uuid,
} from './contract.js';

export type TagRow = Readonly<{ id: string; key: string; revision: string }>;

export const tagRecord = (row: TagRow): WorkflowTagRecord => ({
  id: row.id,
  key: row.key,
  revision: Number(row.revision),
});

export async function readTag(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
): Promise<TagRow> {
  const result = await client.query<TagRow>(
    'select id, key, revision from app.workflow_tags where workspace_id = $1 and id = $2',
    [workspaceId, tagId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new WorkflowNotFoundError('Tag is not visible');
  return row;
}

export async function requireFreeKey(
  client: PoolClient,
  workspaceId: string,
  tagKey: string,
  tagId: string | null,
): Promise<void> {
  const taken = await client.query(
    `select 1 from app.workflow_tags
     where workspace_id = $1 and key = $2 and id is distinct from $3::uuid`,
    [workspaceId, tagKey, tagId],
  );
  if (taken.rowCount !== 0) throw new WorkflowTagConflictError('key');
}

export function requireRevision(row: TagRow, expected: number): void {
  if (Number(row.revision) !== expected)
    throw new WorkflowTagConflictError('tag_revision');
}

export function page(input: PageInput) {
  return {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 50),
    after: input.afterId === undefined ? null : uuid.parse(input.afterId),
  };
}

export function pagination<T>(
  rows: readonly T[],
  limit: number,
  lastId: (item: T) => string,
): Page<T> {
  const items = rows.slice(0, limit).map((item) => Object.freeze(item));
  const last = items.at(-1);
  return Object.freeze({
    items: Object.freeze(items),
    nextId: rows.length > limit && last !== undefined ? lastId(last) : null,
  });
}
