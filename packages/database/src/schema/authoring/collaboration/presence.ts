import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workspaceMemberships } from '../../foundation.js';
import { workflows } from '../workflows.js';
export const workflowPresenceLeases = appSchema.table(
  'workflow_presence_leases',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    userId: uuid('user_id').notNull(),
    tabId: uuid('tab_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    editing: boolean('editing').notNull(),
    dirty: boolean('dirty').notNull(),
    baseRevision: integer('base_revision'),
    lastSeenAt: timestamp('last_seen_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.workflowId, t.userId, t.tabId] }),
    foreignKey({
      name: 'presence_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'presence_member_fk',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('cascade'),
    index('presence_expiry_idx').on(t.expiresAt),
    check(
      'presence_shape_valid',
      sql`sequence>0 and sequence<=9007199254740991 and expires_at>last_seen_at and (base_revision is null or base_revision>0) and (not dirty or editing) and (not editing or base_revision is not null)`,
    ),
  ],
);
