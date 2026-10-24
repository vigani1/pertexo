import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowTags } from '../../../schema/authoring/organization.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
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

export const tagProjection = {
  id: workflowTags.id,
  key: workflowTags.key,
  revision: workflowTags.revision,
};
export type TagRow = Pick<
  typeof workflowTags.$inferSelect,
  keyof typeof tagProjection
>;

export const tagRecord = (row: TagRow): WorkflowTagRecord => ({
  id: row.id,
  key: row.key,
  revision: row.revision,
});

export async function readTag(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
): Promise<TagRow> {
  const [row] = await drizzle(client)
    .select(tagProjection)
    .from(workflowTags)
    .where(
      and(
        eq(workflowTags.workspaceId, workspaceId),
        eq(workflowTags.id, tagId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new WorkflowNotFoundError('Tag is not visible');
  return row;
}

export async function requireFreeKey(
  client: PoolClient,
  workspaceId: string,
  tagKey: string,
  tagId: string | null,
): Promise<void> {
  const taken = await drizzle(client)
    .select({ id: workflowTags.id })
    .from(workflowTags)
    .where(
      and(
        eq(workflowTags.workspaceId, workspaceId),
        eq(workflowTags.key, tagKey),
        sql`${workflowTags.id} is distinct from ${tagId}::uuid`,
      ),
    )
    .catch(rethrowQueryFailure);
  if (taken.length !== 0) throw new WorkflowTagConflictError('key');
}

export function requireRevision(row: TagRow, expected: number): void {
  if (row.revision !== expected)
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
