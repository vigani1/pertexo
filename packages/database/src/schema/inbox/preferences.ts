import type { NoticeEmailMode } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  timestamp,
  uuid,
  varchar,
  boolean,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workspaces, workspaceMemberships } from '../foundation.js';
import { workflows } from '../authoring/workflows.js';
import { connections } from '../connections.js';

export const noticeWorkspaceSettings = appSchema.table(
  'notice_workspace_settings',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    revision: integer('revision').notNull().default(0),
    mode: varchar('mode', { length: 16 })
      .$type<NoticeEmailMode>()
      .notNull()
      .default('off'),
    hour: integer('hour').notNull().default(9),
    timeZone: varchar('time_zone', { length: 128 }).notNull().default('UTC'),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      name: 'notice_workspace_settings_workspace_fk',
      columns: [t.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check(
      'notice_workspace_settings_valid',
      sql`revision>=0 AND mode IN ('off','immediate','hourly','daily') AND hour BETWEEN 0 AND 23`,
    ),
  ],
);
export const noticePreferences = appSchema.table(
  'notice_preferences',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    revision: integer('revision').notNull().default(0),
    mode: varchar('mode', { length: 16 }).$type<NoticeEmailMode>(),
    hour: integer('hour').notNull().default(9),
    timeZone: varchar('time_zone', { length: 128 }).notNull().default('UTC'),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    nextDueAt: timestamp('next_due_at', { withTimezone: true, mode: 'date' }),
    scheduleDefaultRevision: integer('schedule_default_revision')
      .notNull()
      .default(0),
  },
  (t) => [
    primaryKey({
      name: 'notice_preferences_pkey',
      columns: [t.workspaceId, t.userId],
    }),
    foreignKey({
      name: 'notice_preferences_member_fk',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
    check(
      'notice_preferences_valid',
      sql`revision>=0 AND (mode IS NULL OR mode IN ('off','immediate','hourly','daily')) AND hour BETWEEN 0 AND 23 AND schedule_default_revision>=0`,
    ),
  ],
);
export const noticeSubscriptions = appSchema.table(
  'notice_subscriptions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    subjectKind: varchar('subject_kind', { length: 16 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    workflowId: uuid('workflow_id'),
    connectionId: uuid('connection_id'),
    revision: integer('revision').notNull().default(0),
    followed: boolean('followed').notNull().default(false),
    muted: boolean('muted').notNull().default(false),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'notice_subscriptions_pkey',
      columns: [t.workspaceId, t.userId, t.subjectKind, t.subjectId],
    }),
    foreignKey({
      name: 'notice_subscriptions_member_fk',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'notice_subscriptions_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notice_subscriptions_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete('cascade'),
    check(
      'notice_subscriptions_valid',
      sql`revision>=0 AND ((subject_kind='workflow' AND workflow_id=subject_id AND connection_id IS NULL) OR (subject_kind='connection' AND connection_id=subject_id AND workflow_id IS NULL AND NOT followed)) IS TRUE`,
    ),
  ],
);
