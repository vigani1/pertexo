import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  foreignKey,
  index,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';
import { workflowRuns } from '../runs/workflow-runs.js';

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
