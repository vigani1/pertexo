import type {
  WorkspaceInboxThread,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
import type { DatabaseConfig } from '../config.js';
import { noticeVisibilitySql } from './eligibility.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/transactions.js';
import {
  noticeColumns,
  noticeSource,
  projectNotices,
  type NoticeRow,
} from './projection.js';
export type WorkspaceInboxFailureKind =
  'failed' | 'timed_out' | 'outcome_unknown';
export type WorkspaceInboxThreadRecord = WorkspaceInboxThread;
export type WorkspaceInboxCursor = Readonly<{
  latestOccurredAt: string;
  threadId: string;
}>;
export type WorkspaceInboxThreadPage = Readonly<{
  items: readonly WorkspaceInboxThread[];
  next: WorkspaceInboxCursor | null;
  revision: string;
}>;
export type WorkspaceInboxSummary = Readonly<{
  unreadCount: number;
  revision: string;
}>;
type ReaderScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export interface WorkspaceInboxDatabase {
  listThreads(
    input: ReaderScope &
      Readonly<{
        filter: 'all' | 'unread';
        noticeKind?: WorkspaceNoticeKind;
        limit: number;
        after?: WorkspaceInboxCursor;
      }>,
  ): Promise<WorkspaceInboxThreadPage>;
  readSummary(input: ReaderScope): Promise<WorkspaceInboxSummary>;
  markThreadRead(
    input: ReaderScope & Readonly<{ threadId: string; revision: string }>,
  ): Promise<Readonly<{ unread: boolean; revision: string }> | undefined>;
  markAllRead(
    input: ReaderScope & Readonly<{ revision: string }>,
  ): Promise<Readonly<{ marked: number }>>;
  close(): Promise<void>;
}
export function createWorkspaceInboxDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInboxDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const scope = (i: ReaderScope) => ({
    workspaceId: i.workspaceId,
    actorId: i.actorId,
  });
  const options = (i: ReaderScope) => ({
    statementTimeoutMillis: 2000,
    ...(i.signal === undefined ? {} : { signal: i.signal }),
  });
  return {
    close: () => lease.close(),
    listThreads: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        scope(input),
        async (client) => {
          const found = await client.query<NoticeRow>(
            `select ${noticeColumns} ${noticeSource} where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')}
 and ($3::boolean is false or seen.read_revision is null or seen.read_revision<thread.revision)
 and ($4::timestamptz is null or (thread.latest_occurred_at,thread.id)<($4::timestamptz,$5::uuid))
 and ($7::varchar is null or thread.notice_kind=$7)
 order by thread.latest_occurred_at desc,thread.id desc limit $6`,
            [
              input.workspaceId,
              input.actorId,
              input.filter === 'unread',
              input.after?.latestOccurredAt ?? null,
              input.after?.threadId ?? null,
              input.limit + 1,
              input.noticeKind ?? null,
            ],
          );
          const page = found.rows.slice(0, input.limit);
          const last = page.at(-1);
          const revision = await client.query<{ revision: string }>(
            `select coalesce(max(thread.revision),0)::text revision from app.workspace_inbox_threads thread where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')}`,
            [input.workspaceId, input.actorId],
          );
          return {
            items: await projectNotices(client, input.workspaceId, page),
            next:
              found.rows.length > input.limit && last !== undefined
                ? {
                    latestOccurredAt: last.latest_occurred_at,
                    threadId: last.id,
                  }
                : null,
            revision: revision.rows[0]?.revision ?? '0',
          };
        },
        options(input),
      ),
    readSummary: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        scope(input),
        async (client) => {
          const result = await client.query<{
            unread_count: string;
            revision: string;
          }>(
            `select count(*) filter(where seen.read_revision is null or seen.read_revision<thread.revision)::text unread_count,coalesce(max(thread.revision),0)::text revision from app.workspace_inbox_threads thread left join app.workspace_inbox_reads seen on seen.workspace_id=thread.workspace_id and seen.thread_id=thread.id and seen.user_id=$2 where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')}`,
            [input.workspaceId, input.actorId],
          );
          return {
            unreadCount: Number(result.rows[0]?.unread_count ?? 0),
            revision: result.rows[0]?.revision ?? '0',
          };
        },
        options(input),
      ),
    markThreadRead: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        async (client) => {
          await client.query(
            `insert into app.workspace_inbox_reads as seen(workspace_id,user_id,thread_id,read_revision) select thread.workspace_id,$2,thread.id,least($4::bigint,thread.revision) from app.workspace_inbox_threads thread where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')} and thread.id=$3 and $4::bigint>0 on conflict(workspace_id,user_id,thread_id) do update set read_revision=excluded.read_revision,read_at=clock_timestamp() where seen.read_revision<excluded.read_revision`,
            [input.workspaceId, input.actorId, input.threadId, input.revision],
          );
          const current = await client.query<{
            revision: string;
            unread: boolean;
          }>(
            `select thread.revision::text,(seen.read_revision is null or seen.read_revision<thread.revision) unread from app.workspace_inbox_threads thread left join app.workspace_inbox_reads seen on seen.workspace_id=thread.workspace_id and seen.thread_id=thread.id and seen.user_id=$2 where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')} and thread.id=$3`,
            [input.workspaceId, input.actorId, input.threadId],
          );
          return current.rows[0];
        },
        options(input),
      ),
    markAllRead: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        async (client) => {
          const result = await client.query(
            `insert into app.workspace_inbox_reads as seen(workspace_id,user_id,thread_id,read_revision) select thread.workspace_id,$2,thread.id,thread.revision from app.workspace_inbox_threads thread where thread.workspace_id=$1 and ${noticeVisibilitySql('$2')} and thread.revision<=$3::bigint on conflict(workspace_id,user_id,thread_id) do update set read_revision=excluded.read_revision,read_at=clock_timestamp() where seen.read_revision<excluded.read_revision`,
            [input.workspaceId, input.actorId, input.revision],
          );
          return { marked: result.rowCount ?? 0 };
        },
        options(input),
      ),
  };
}
