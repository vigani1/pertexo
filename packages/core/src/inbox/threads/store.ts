import type {
  ReaderScope,
  WorkspaceInboxStore,
  WorkspaceInboxThreadPage,
  WorkspaceInboxSummary,
} from './contract.js';
import type { PoolClient } from 'pg';
import {
  readBrowsableFolderScope,
  readFolderScope,
} from '../../shared/facts.queries.js';
import { folderScope } from '../../tenant-access/resources/policy.js';
import { lockWorkspaceAuthority } from '../../shared/authority.queries.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { ROLES } from '@pertexo/workflow-model';

import type { DatabaseConfig } from '@pertexo/database/platform';
import { noticeVisibilitySql } from './eligibility.queries.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { workspaceInboxReads } from '@pertexo/database/schema';
import { noticeRecords, thread, seen, unreadSql } from './records.queries.js';
import { projectNotices } from './projection.js';
async function noticeAccess(
  client: PoolClient,
  input: ReaderScope,
  { write }: Readonly<{ write: boolean }>,
) {
  if (!write) return readBrowsableFolderScope(client, input);
  try {
    const role = await lockWorkspaceAuthority(
      client,
      input.workspaceId,
      input.actorId,
      ROLES,
    );
    return await readFolderScope(client, input, role);
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      return folderScope(input.workspaceId, null, [], []);
    throw error;
  }
}

export function createWorkspaceInboxStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInboxStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    listThreads: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        scope(input),
        (client) => listThreads(client, input),
        options(input),
      ),
    readSummary: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        scope(input),
        (client) => readSummary(client, input),
        options(input),
      ),
    markThreadRead: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        (client) => markThreadRead(client, input),
        options(input),
      ),
    markAllRead: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        (client) => markAllRead(client, input),
        options(input),
      ),
  };
}
function scope(input: ReaderScope) {
  return { workspaceId: input.workspaceId, actorId: input.actorId };
}
function options(input: ReaderScope) {
  return {
    statementTimeoutMillis: 2000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}
async function listThreads(
  client: PoolClient,
  input: Parameters<WorkspaceInboxStore['listThreads']>[0],
): Promise<WorkspaceInboxThreadPage> {
  const db = drizzle(client);
  const resources = await noticeAccess(client, input, { write: false });
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
async function readSummary(
  client: PoolClient,
  input: ReaderScope,
): Promise<WorkspaceInboxSummary> {
  const db = drizzle(client);
  const resources = await noticeAccess(client, input, { write: false });
  const [result] = await db
    .select({
      unreadCount: sql<string>`count(*) filter(where ${unreadSql})::text`,
      revision: sql<string>`coalesce(max(${thread.revision}),0)::text`,
    })
    .from(thread)
    .leftJoin(
      seen,
      and(
        eq(seen.workspaceId, thread.workspaceId),
        eq(seen.threadId, thread.id),
        eq(seen.userId, input.actorId),
      ),
    )
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
const excluded = alias(workspaceInboxReads, 'excluded');
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
async function markThreadRead(
  client: PoolClient,
  input: Parameters<WorkspaceInboxStore['markThreadRead']>[0],
) {
  const db = drizzle(client);
  const resources = await noticeAccess(client, input, { write: true });
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
    .leftJoin(
      seen,
      and(
        eq(seen.workspaceId, thread.workspaceId),
        eq(seen.threadId, thread.id),
        eq(seen.userId, input.actorId),
      ),
    )
    .where(visible)
    .catch(rethrowQueryFailure);
  return current;
}
async function markAllRead(
  client: PoolClient,
  input: Parameters<WorkspaceInboxStore['markAllRead']>[0],
) {
  const db = drizzle(client);
  const resources = await noticeAccess(client, input, { write: true });
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
