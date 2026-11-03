import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  type PgTableExtraConfigValue,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { workflowRuns } from './workflow-runs.js';

export const runEvents = appSchema.table(
  'run_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id').notNull(),
    sequence: integer('sequence').notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'run_events_payload_bounded',
      sql`(octet_length((payload)::text) <= 524288)`,
    ),
    check('run_events_sequence_positive', sql`(sequence > 0)`),
    check(
      'run_events_type_catalog',
      sql`((type)::text = ANY (ARRAY[('run.queued'::character varying)::text, ('run.started'::character varying)::text, ('run.waiting'::character varying)::text, ('run.cancel_requested'::character varying)::text, ('run.succeeded'::character varying)::text, ('run.failed'::character varying)::text, ('run.canceled'::character varying)::text, ('run.timed_out'::character varying)::text, ('run.outcome_unknown'::character varying)::text, ('node.ready'::character varying)::text, ('node.reused'::character varying)::text, ('node.failure_routed'::character varying)::text, ('node.failure_handled'::character varying)::text, ('node.started'::character varying)::text, ('node.progress'::character varying)::text, ('node.waiting'::character varying)::text, ('node.retry_scheduled'::character varying)::text, ('node.succeeded'::character varying)::text, ('node.failed'::character varying)::text, ('node.skipped'::character varying)::text, ('node.canceled'::character varying)::text, ('node.timed_out'::character varying)::text, ('node.outcome_unknown'::character varying)::text]))`,
    ),
    primaryKey({
      name: 'run_events_pkey',
      columns: [table.workflowRunId, table.sequence],
    }),
    foreignKey({
      name: 'run_events_run_workspace_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    index('run_events_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst(),
      table.workflowRunId,
      table.sequence,
    ),
  ],
);
