import { sql, type SQLWrapper } from 'drizzle-orm';
import { workspaceInboxThreads as thread } from '@pertexo/database/schema';
/** Shared F27 notice window; comment storage has its own indefinite lifetime. */
export const NOTICE_WINDOW_SQL = sql`interval '720 hours'`;
/** These last for the window; every other kind lasts until its cause clears. */
export const windowedNoticeSql = (noticeKind: SQLWrapper) =>
  sql<boolean>`${noticeKind} in ('workflow_failure','workflow_mention')`;
/** Recheck after waits so retention cannot erase a reactivated episode. */
export const expiredNoticeSql = sql`${thread.latestOccurredAt} <= statement_timestamp() - ${NOTICE_WINDOW_SQL} and (${windowedNoticeSql(thread.noticeKind)} or not ${thread.active})`;
