import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { appSchema } from './app-schema.js';
import { workflowRuns } from './execution.js';
import { workspaceMemberships, workspaces } from './foundation.js';

// String-mode timestamps and bigint revisions preserve PostgreSQL precision.
export const workspaceInboxSources = appSchema.table(
  'workspace_inbox_sources',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').notNull(),
    terminalEventSequence: bigint('terminal_event_sequence', {
      mode: 'bigint',
    }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    checksum: char('checksum', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    evidenceUntil: timestamp('evidence_until', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    capturedAt: timestamp('captured_at', {
      withTimezone: true,
      mode: 'string',
    }),
    audienceCount: bigint('audience_count', { mode: 'bigint' })
      .default(0n)
      .notNull(),
    lastRecipientUserId: uuid('last_recipient_user_id'),
    consecutiveAttempts: integer('consecutive_attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
    fenceToken: bigint('fence_token', { mode: 'bigint' }).default(0n).notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'workspace_inbox_sources_run_workspace_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    uniqueIndex('workspace_inbox_sources_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('workspace_inbox_sources_terminal_unique').on(
      table.workspaceId,
      table.runId,
      table.terminalEventSequence,
      table.kind,
    ),
    index('workspace_inbox_sources_due_idx')
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.status} IN ('pending','captured')`),
    index('workspace_inbox_sources_evidence_idx').on(
      table.workspaceId,
      table.evidenceUntil,
      table.id,
    ),
  ],
);

export const workspaceInboxAudience = appSchema.table(
  'workspace_inbox_audience',
  {
    workspaceId: uuid('workspace_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    userId: uuid('user_id').notNull(),
    observedRoleRevision: integer('observed_role_revision').notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    processedAt: timestamp('processed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.sourceId, table.userId] }),
    foreignKey({
      name: 'workspace_inbox_audience_source_workspace_fk',
      columns: [table.workspaceId, table.sourceId],
      foreignColumns: [
        workspaceInboxSources.workspaceId,
        workspaceInboxSources.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_inbox_audience_membership_workspace_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
  ],
);

export const workspaceInboxRecipientState = appSchema.table(
  'workspace_inbox_recipient_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).default(0n).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    foreignKey({
      name: 'workspace_inbox_recipient_state_membership_workspace_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
  ],
);

export const workspaceInboxEntries = appSchema.table(
  'workspace_inbox_entries',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    userId: uuid('user_id').notNull(),
    creationRevision: bigint('creation_revision', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      name: 'workspace_inbox_entries_source_workspace_fk',
      columns: [table.workspaceId, table.sourceId],
      foreignColumns: [
        workspaceInboxSources.workspaceId,
        workspaceInboxSources.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_inbox_entries_recipient_workspace_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceInboxRecipientState.workspaceId,
        workspaceInboxRecipientState.userId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_inbox_entries_audience_workspace_fk',
      columns: [table.workspaceId, table.sourceId, table.userId],
      foreignColumns: [
        workspaceInboxAudience.workspaceId,
        workspaceInboxAudience.sourceId,
        workspaceInboxAudience.userId,
      ],
    }).onDelete('restrict'),
    uniqueIndex('workspace_inbox_entries_source_recipient_unique').on(
      table.workspaceId,
      table.sourceId,
      table.userId,
    ),
    uniqueIndex('workspace_inbox_entries_recipient_revision_unique').on(
      table.workspaceId,
      table.userId,
      table.creationRevision,
    ),
    index('workspace_inbox_entries_recipient_created_idx').on(
      table.workspaceId,
      table.userId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('workspace_inbox_entries_recipient_unread_idx')
      .on(
        table.workspaceId,
        table.userId,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.readAt} IS NULL`),
    index('workspace_inbox_entries_expiry_idx').on(
      table.workspaceId,
      table.expiresAt,
      table.id,
    ),
  ],
);
