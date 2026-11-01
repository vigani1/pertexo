import type {
  WorkspaceNoticeKind,
  WorkspaceCapacityLimit,
} from '@pertexo/contracts';
import { workflowCommentMentions } from '../authoring/collaboration/mentions.js';
import { workflowPublicationRequests } from '../authoring/publication-requests.js';
import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';
import { workflowRuns } from '../runs/execution.js';
import { connections } from '../connections.js';
import { pendingRunTasks } from '../runs/pending-task.js';
import { workspaces, workspaceMemberships } from '../foundation.js';

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
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_inbox_events_kind_check',
      sql`((kind)::text = ANY (ARRAY[('failed'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'workspace_inbox_events_terminal_event_sequence_check',
      sql`(terminal_event_sequence > 0)`,
    ),
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
    index('workspace_inbox_events_pending_idx').on(table.createdAt, table.id),
    uniqueIndex('workspace_inbox_events_terminal_unique').on(
      table.workspaceId,
      table.runId,
      table.terminalEventSequence,
    ),
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
    id: uuid('id').notNull(),
    noticeKind: varchar('notice_kind', { length: 32 })
      .$type<WorkspaceNoticeKind>()
      .notNull(),
    subjectId: uuid('subject_id').notNull(),
    connectionId: uuid('connection_id'),
    taskId: uuid('task_id'),
    publicationRequestId: uuid('publication_request_id'),
    commentMentionId: uuid('comment_mention_id'),
    active: boolean('active').notNull().default(true),
    sourceRevision: varchar('source_revision', { length: 128 }),
    capacityLimit: varchar('capacity_limit', {
      length: 16,
    }).$type<WorkspaceCapacityLimit>(),
    workflowId: uuid('workflow_id'),
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
    latestRunId: uuid('latest_run_id'),
    latestKind: varchar('latest_kind', { length: 32 }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'workspace_inbox_threads_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    uniqueIndex('workspace_inbox_threads_subject_unique').on(
      table.workspaceId,
      table.noticeKind,
      table.subjectId,
    ),
    uniqueIndex('workspace_inbox_threads_capacity_limit_unique')
      .on(table.workspaceId, table.capacityLimit)
      .where(sql`notice_kind='limit_approaching'`),
    check(
      'workspace_inbox_threads_subject_valid',
      sql`((((notice_kind='publication_review_waiting' AND publication_request_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL AND task_id IS NULL AND capacity_limit IS NULL) OR (publication_request_id IS NULL AND ((notice_kind='limit_approaching' AND subject_id=id AND capacity_limit IN ('active','queue','artifact_bytes','artifact_count') AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL) OR (capacity_limit IS NULL AND ((notice_kind IN ('workflow_failure','workflow_auto_paused') AND workflow_id=subject_id AND connection_id IS NULL AND task_id IS NULL) OR (notice_kind='connection_attention' AND connection_id=subject_id AND workflow_id IS NULL AND task_id IS NULL) OR (notice_kind='approval_waiting' AND task_id=subject_id AND workflow_id IS NOT NULL AND connection_id IS NULL) OR (notice_kind='limit_reached' AND subject_id=workspace_id AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL) OR (notice_kind='failure_alert_attention' AND workflow_id IS NULL AND connection_id IS NULL AND task_id IS NULL)))))) and comment_mention_id is null) or (notice_kind='workflow_mention' and comment_mention_id=subject_id and workflow_id is not null and connection_id is null and task_id is null and publication_request_id is null and capacity_limit is null)) IS TRUE`,
    ),
    check(
      'workspace_inbox_threads_failure_valid',
      sql`((notice_kind='workflow_failure' AND latest_run_id IS NOT NULL AND latest_kind IS NOT NULL) OR (notice_kind<>'workflow_failure' AND latest_run_id IS NULL AND latest_kind IS NULL)) IS TRUE`,
    ),
    foreignKey({
      name: 'workspace_inbox_threads_comment_mention_fk',
      columns: [table.workspaceId, table.commentMentionId],
      foreignColumns: [
        workflowCommentMentions.workspaceId,
        workflowCommentMentions.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_inbox_threads_connection_fk',
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_inbox_threads_publication_request_fk',
      columns: [table.workspaceId, table.publicationRequestId],
      foreignColumns: [
        workflowPublicationRequests.workspaceId,
        workflowPublicationRequests.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_inbox_threads_task_fk',
      columns: [table.workspaceId, table.taskId],
      foreignColumns: [pendingRunTasks.workspaceId, pendingRunTasks.id],
    }).onDelete('cascade'),
    check(
      'workspace_inbox_threads_latest_kind_check',
      sql`((latest_kind)::text = ANY (ARRAY[('failed'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'workspace_inbox_threads_occurrence_count_check',
      sql`(occurrence_count > 0)`,
    ),
    check(
      'workspace_inbox_threads_occurrence_order',
      sql`(latest_occurred_at >= first_occurred_at)`,
    ),
    check('workspace_inbox_threads_revision_check', sql`(revision > 0)`),
    primaryKey({
      name: 'workspace_inbox_threads_pkey',
      columns: [table.workspaceId, table.id],
    }),
    foreignKey({
      name: 'workspace_inbox_threads_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
    index('workspace_inbox_threads_expiry_idx').on(
      table.latestOccurredAt,
      table.workspaceId,
      table.id,
    ),
    index('workspace_inbox_threads_recent_idx').on(
      table.workspaceId,
      table.latestOccurredAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);

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
