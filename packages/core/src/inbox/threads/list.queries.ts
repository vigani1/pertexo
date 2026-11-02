import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { WorkspaceActor } from '../../shared/workspace-access.js';
import type { FolderScope } from '../../shared/contract.js';
import type {
  ListThreadsInput,
  WorkspaceInboxSummary,
  WorkspaceInboxThreadPage,
} from './contract.js';
import { noticeVisibilitySql } from './eligibility.queries.js';
import { projectNotices } from './projection.js';
import {
  noticeRecords,
  seen,
  seenByActor,
  thread,
  unreadSql,
} from './records.queries.js';

export async function listThreads(
  client: PoolClient,
  input: ListThreadsInput,
  resources: FolderScope,
): Promise<WorkspaceInboxThreadPage> {
  const db = drizzle(client);
  const visible = and(
    eq(thread.workspaceId, input.workspaceId),
    noticeVisibilitySql(db, input.actorId, resources),
  );
  const found = await noticeRecords(db, input.actorId)
    .where(
      and(
        visible,
        input.filter === 'unread' ? unreadSql : undefined,
        input.after === undefined
          ? undefined
          : sql`(${thread.latestOccurredAt},${thread.id})<(${input.after.latestOccurredAt}::timestamptz,${input.after.threadId}::uuid)`,
        input.noticeKind === undefined
          ? undefined
          : eq(thread.noticeKind, input.noticeKind),
      ),
    )
    .orderBy(desc(thread.latestOccurredAt), desc(thread.id))
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
  const page = found.slice(0, input.limit);
  const last = page.at(-1);
  const [revision] = await db
    .select({
      revision: sql<string>`coalesce(max(${thread.revision}),0)::text`,
    })
    .from(thread)
    .where(visible)
    .catch(rethrowQueryFailure);
  return {
    items: await projectNotices(client, input.workspaceId, page),
    next:
      found.length > input.limit && last !== undefined
        ? { latestOccurredAt: last.latest_occurred_at, threadId: last.id }
        : null,
    revision: revision?.revision ?? '0',
  };
}

export async function readSummary(
  client: PoolClient,
  input: WorkspaceActor,
  resources: FolderScope,
): Promise<WorkspaceInboxSummary> {
  const db = drizzle(client);
  const [result] = await db
    .select({
      unreadCount: sql<string>`count(*) filter(where ${unreadSql})::text`,
      revision: sql<string>`coalesce(max(${thread.revision}),0)::text`,
    })
    .from(thread)
    .leftJoin(seen, seenByActor(input.actorId))
    .where(
      and(
        eq(thread.workspaceId, input.workspaceId),
        noticeVisibilitySql(db, input.actorId, resources),
      ),
    )
    .catch(rethrowQueryFailure);
  return {
    unreadCount: Number(result?.unreadCount ?? 0),
    revision: result?.revision ?? '0',
  };
}
