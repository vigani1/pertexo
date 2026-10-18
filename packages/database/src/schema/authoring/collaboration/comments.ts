import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { users } from '../../foundation.js';
import { workflowCommentThreads } from './threads.js';
export const workflowComments = appSchema.table(
  'workflow_comments',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    threadId: uuid('thread_id').notNull(),
    authorId: uuid('author_id'),
    body: text('body').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      name: 'comment_thread_fk',
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [
        workflowCommentThreads.workspaceId,
        workflowCommentThreads.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'comment_author_fk',
      columns: [t.authorId],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    index('comments_thread_idx').on(t.workspaceId, t.threadId, t.id),
    check(
      'comment_text_valid',
      sql`length(btrim(body)) between 1 and 8000 and revision>0`,
    ),
  ],
);
