import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  foreignKey,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workspaceMemberships } from '../tenant-access/memberships.js';
import { workspaceInboxThreads } from './threads.js';

/** Each reader's private state: the revision of each thread they read. */
export const workspaceInboxReads = appSchema.table(
  'workspace_inbox_reads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    readRevision: bigint('read_revision', { mode: 'bigint' }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_inbox_reads_read_revision_check',
      sql`(read_revision > 0)`,
    ),
    primaryKey({
      name: 'workspace_inbox_reads_pkey',
      columns: [table.workspaceId, table.userId, table.threadId],
    }),
    foreignKey({
      name: 'workspace_inbox_reads_membership_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_inbox_reads_thread_fk',
      columns: [table.workspaceId, table.threadId],
      foreignColumns: [
        workspaceInboxThreads.workspaceId,
        workspaceInboxThreads.id,
      ],
    }).onDelete('cascade'),
  ],
);
