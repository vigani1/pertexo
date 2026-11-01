import { sql } from 'drizzle-orm';
import { workspaceInboxThreads as thread } from '@pertexo/database/schema';
/** Shared F27 notice window; comment storage has its own indefinite lifetime. */
export const NOTICE_WINDOW_SQL = sql`interval '720 hours'`;
/** Recheck after waits so retention cannot erase a reactivated episode. */
export const expiredNoticeSql = sql`${thread.latestOccurredAt} <= statement_timestamp() - ${NOTICE_WINDOW_SQL} and (${thread.noticeKind} in ('workflow_failure','workflow_mention') or not ${thread.active})`;
