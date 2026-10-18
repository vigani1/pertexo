import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workspaceMemberships } from '../../foundation.js';
import { workflowComments } from './comments.js';
export const workflowCommentMentions = appSchema.table(
  'workflow_comment_mentions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid('id').notNull(),
    commentId: uuid('comment_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      name: 'comment_mention_comment_fk',
      columns: [t.workspaceId, t.commentId],
      foreignColumns: [workflowComments.workspaceId, workflowComments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'comment_mention_member_fk',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('cascade'),
    uniqueIndex('comment_mention_person_unique').on(
      t.workspaceId,
      t.commentId,
      t.userId,
    ),
    index('comment_mentions_recent_idx').on(t.createdAt, t.id),
  ],
);
