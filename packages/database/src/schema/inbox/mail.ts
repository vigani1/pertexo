import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  bigint,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workspaceMemberships } from '../foundation.js';
import { systemMailDeliveries } from '../mail/deliveries.js';
import { workspaceInboxThreads } from './core.js';
export const noticeMailBatches = appSchema.table(
  'notice_mail_batches',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    preferenceRevision: integer('preference_revision').notNull(),
    defaultRevision: integer('default_revision').notNull(),
    memberRevision: integer('member_revision').notNull(),
    recipient: varchar('recipient', { length: 320 }).notNull(),
    windowKey: varchar('window_key', { length: 64 }).notNull(),
    itemCount: integer('item_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    foreignKey({
      name: 'notice_mail_batches_delivery_fk',
      columns: [t.id],
      foreignColumns: [systemMailDeliveries.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notice_mail_batches_member_fk',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
    uniqueIndex('notice_mail_batches_window_unique')
      .on(t.workspaceId, t.userId, t.windowKey)
      .where(sql`released_at IS NULL`),
    index('notice_mail_batches_person_idx').on(
      t.workspaceId,
      t.userId,
      t.createdAt,
    ),
    uniqueIndex('notice_mail_batches_workspace_unique').on(t.workspaceId, t.id),
    check(
      'notice_mail_batches_valid',
      sql`preference_revision>=0 AND default_revision>=0 AND member_revision>0 AND item_count BETWEEN 1 AND 100`,
    ),
  ],
);
export const noticeMailItems = appSchema.table(
  'notice_mail_items',
  {
    workspaceId: uuid('workspace_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'notice_mail_items_pkey',
      columns: [t.workspaceId, t.batchId, t.threadId],
    }),
    foreignKey({
      name: 'notice_mail_items_batch_fk',
      columns: [t.workspaceId, t.batchId],
      foreignColumns: [noticeMailBatches.workspaceId, noticeMailBatches.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notice_mail_items_thread_fk',
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [
        workspaceInboxThreads.workspaceId,
        workspaceInboxThreads.id,
      ],
    }).onDelete('cascade'),
    index('notice_mail_items_coverage_idx').on(
      t.workspaceId,
      t.threadId,
      t.revision,
    ),
    check('notice_mail_items_revision_valid', sql`revision>0`),
  ],
);
