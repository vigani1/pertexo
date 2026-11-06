import { and, eq, exists, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  workspaceInboxThreads as thread,
  workspaceInboxFailureDays as days,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { expiredNoticeSql } from './lifetime.js';
export const INBOX_RETENTION_RULE = {
  name: 'workspace_inbox_threads',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db
      .$with('page')
      .as(
        db
          .select({ workspaceId: thread.workspaceId, id: thread.id })
          .from(thread)
          .where(expiredNoticeSql)
          .orderBy(thread.latestOccurredAt, thread.workspaceId, thread.id)
          .limit(pageSize),
      );
    const removed = await db
      .with(page)
      .delete(thread)
      .where(
        and(
          expiredNoticeSql,
          exists(
            db
              .select({ id: page.id })
              .from(page)
              .where(
                and(
                  eq(page.workspaceId, thread.workspaceId),
                  eq(page.id, thread.id),
                ),
              ),
          ),
        ),
      )
      .returning({ id: thread.id })
      .catch(rethrowQueryFailure);
    const remaining = pageSize - removed.length;
    if (remaining === 0) return removed.length;
    const expiredDay = lt(
      days.day,
      sql`(statement_timestamp() at time zone 'UTC')::date-29`,
    );
    const dayPage = db.$with('expired_days').as(
      db
        .select({
          workspaceId: days.workspaceId,
          workflowId: days.workflowId,
          day: days.day,
        })
        .from(days)
        .where(expiredDay)
        .orderBy(days.day, days.workspaceId, days.workflowId)
        .limit(remaining),
    );
    const pruned = await db
      .with(dayPage)
      .delete(days)
      .where(
        and(
          expiredDay,
          exists(
            db
              .select({ day: dayPage.day })
              .from(dayPage)
              .where(
                and(
                  eq(dayPage.workspaceId, days.workspaceId),
                  eq(dayPage.workflowId, days.workflowId),
                  eq(dayPage.day, days.day),
                ),
              ),
          ),
        ),
      )
      .returning({ day: days.day })
      .catch(rethrowQueryFailure);
    return removed.length + pruned.length;
  },
} as const;
