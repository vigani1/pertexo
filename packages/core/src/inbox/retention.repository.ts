import { and, eq, exists } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { workspaceInboxThreads as thread } from '@pertexo/database/schema';
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
    return removed.length;
  },
} as const;
