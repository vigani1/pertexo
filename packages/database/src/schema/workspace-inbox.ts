import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { appSchema } from './app-schema.js';
import { workflows } from './authoring.js';
import { workflowRuns } from './execution.js';
import { workspaceMemberships } from './foundation.js';

// ADR 055. String-mode timestamps and bigint revisions preserve PostgreSQL
// precision.

/** Pending terminal failures, deleted once folded into their thread. */
export const workspaceInboxEvents = appSchema.table(
  'workspace_inbox_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    runId: uuid('run_id').notNull(),
    terminalEventSequence: bigint('terminal_event_sequence', {
      mode: 'bigint',
    }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'workspace_inbox_events_run_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_inbox_events_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    uniqueIndex('workspace_inbox_events_terminal_unique').on(
      table.workspaceId,
      table.runId,
      table.terminalEventSequence,
    ),
    index('workspace_inbox_events_pending_idx').on(table.createdAt, table.id),
    index('workspace_inbox_events_workflow_idx').on(
      table.workspaceId,
      table.workflowId,
    ),
  ],
);

/** One thread per failing workflow, shared by the workspace's readers. */
export const workspaceInboxThreads = appSchema.table(
  'workspace_inbox_threads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
    occurrenceCount: bigint('occurrence_count', { mode: 'bigint' }).notNull(),
    firstOccurredAt: timestamp('first_occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    latestOccurredAt: timestamp('latest_occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    latestRunId: uuid('latest_run_id').notNull(),
    latestKind: varchar('latest_kind', { length: 32 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'workspace_inbox_threads_pkey',
      columns: [table.workspaceId, table.workflowId],
    }),
    foreignKey({
      name: 'workspace_inbox_threads_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
    index('workspace_inbox_threads_recent_idx').on(
      table.workspaceId,
      table.latestOccurredAt.desc(),
      table.workflowId.desc(),
    ),
    index('workspace_inbox_threads_expiry_idx').on(
      table.latestOccurredAt,
      table.workspaceId,
      table.workflowId,
    ),
  ],
);

/** Each reader's private state: the revision of each thread they read. */
export const workspaceInboxReads = appSchema.table(
  'workspace_inbox_reads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    readRevision: bigint('read_revision', { mode: 'bigint' }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'workspace_inbox_reads_pkey',
      columns: [table.workspaceId, table.userId, table.workflowId],
    }),
    foreignKey({
      name: 'workspace_inbox_reads_thread_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [
        workspaceInboxThreads.workspaceId,
        workspaceInboxThreads.workflowId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_inbox_reads_membership_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
  ],
);
