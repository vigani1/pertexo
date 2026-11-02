import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceInboxReads } from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import type { FolderScope } from '../../shared/contract.js';
import type { MarkAllReadInput, MarkThreadReadInput } from './contract.js';
import { noticeVisibilitySql } from './eligibility.queries.js';
import { seen, seenByActor, thread, unreadSql } from './records.queries.js';

const excluded = alias(workspaceInboxReads, 'excluded');
/** A read never moves backwards. */
const readConflict = {
  target: [
    workspaceInboxReads.workspaceId,
    workspaceInboxReads.userId,
    workspaceInboxReads.threadId,
  ],
  set: {
    readRevision: sql`${excluded.readRevision}`,
    readAt: sql`clock_timestamp()`,
  },
  setWhere: sql`${workspaceInboxReads.readRevision}<${excluded.readRevision}`,
};

export async function markThreadRead(
  client: PoolClient,
  input: MarkThreadReadInput,
  resources: FolderScope,
) {
  const db = drizzle(client);
  const visible = and(
    eq(thread.workspaceId, input.workspaceId),
    noticeVisibilitySql(db, input.actorId, resources),
    eq(thread.id, input.threadId),
  );
  await db
    .insert(workspaceInboxReads)
    .select(
      db
        .select({
          workspaceId: thread.workspaceId,
          userId: sql<string>`${input.actorId}::uuid`.as('user_id'),
          threadId: thread.id,
          readRevision:
            sql<bigint>`least(${input.revision}::bigint,${thread.revision})`.as(
              'read_revision',
            ),
          readAt: sql`clock_timestamp()`.as('read_at'),
        })
        .from(thread)
        .where(and(visible, sql`${input.revision}::bigint>0`)),
    )
    .onConflictDoUpdate(readConflict)
    .catch(rethrowQueryFailure);
  const [current] = await db
    .select({
      revision: sql<string>`${thread.revision}::text`,
      unread: unreadSql,
    })
    .from(thread)
    .leftJoin(seen, seenByActor(input.actorId))
    .where(visible)
    .catch(rethrowQueryFailure);
  return current;
}

export async function markAllRead(
  client: PoolClient,
  input: MarkAllReadInput,
  resources: FolderScope,
) {
  const db = drizzle(client);
  const result = await db
    .insert(workspaceInboxReads)
    .select(
      db
        .select({
          workspaceId: thread.workspaceId,
          userId: sql<string>`${input.actorId}::uuid`.as('user_id'),
          threadId: thread.id,
          readRevision: thread.revision,
          readAt: sql`clock_timestamp()`.as('read_at'),
        })
        .from(thread)
        .where(
          and(
            eq(thread.workspaceId, input.workspaceId),
            noticeVisibilitySql(db, input.actorId, resources),
            sql`${thread.revision}<=${input.revision}::bigint`,
          ),
        ),
    )
    .onConflictDoUpdate(readConflict)
    .returning({ threadId: workspaceInboxReads.threadId })
    .catch(rethrowQueryFailure);
  return { marked: result.length };
}
