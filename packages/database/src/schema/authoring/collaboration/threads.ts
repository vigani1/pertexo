import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { users } from '../../foundation.js';
import { workflows } from '../workflows.js';
export const workflowCommentThreads = appSchema.table(
  'workflow_comment_threads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    stepId: varchar('step_id', { length: 128 }),
    stepLabel: varchar('step_label', { length: 256 }),
    status: varchar('status', { length: 16 })
      .$type<'open' | 'resolved'>()
      .notNull()
      .default('open'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by'),
    commentCount: integer('comment_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      name: 'comment_thread_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'comment_thread_author_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    index('comment_threads_workflow_idx').on(t.workspaceId, t.workflowId, t.id),
    check(
      'comment_thread_shape',
      sql`revision>0 and comment_count>=0 and status in ('open','resolved') and ((step_id is null and step_label is null) or (length(step_id)>0 and step_label is not null))`,
    ),
  ],
);
