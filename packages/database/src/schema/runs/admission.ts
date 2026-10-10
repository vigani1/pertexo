import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from '../app-schema.js';
import { workflowRuns } from './execution.js';
import { workspaces } from '../foundation.js';
import { outboxEvents } from '../transport.js';

export const workspaceExecutionAdmissionCounters = appSchema.table(
  'workspace_execution_admission_counters',
  {
    workspaceId: uuid('workspace_id').primaryKey().notNull(),
    queuedRuns: integer('queued_runs').default(0).notNull(),
    activeRuns: integer('active_runs').default(0).notNull(),
    reconciledAt: timestamp('reconciled_at', {
      withTimezone: true,
      mode: 'string',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_execution_admission_counters_nonnegative',
      sql`((queued_runs >= 0) AND (active_runs >= 0))`,
    ),
    foreignKey({
      name: 'workspace_execution_admission_counters_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
  ],
);

export const workflowRunActiveAdmissions = appSchema.table(
  'workflow_run_active_admissions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id').primaryKey().notNull(),
    outboxEventId: uuid('outbox_event_id').notNull(),
    recoverAfter: timestamp('recover_after', {
      withTimezone: true,
      mode: 'string',
    }),
    recoveryCount: bigint('recovery_count', { mode: 'number' })
      .default(0)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    workflowConcurrencyOrderExempt: boolean('workflow_concurrency_order_exempt')
      .default(true)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_run_active_admissions_recovery_count_valid',
      sql`(recovery_count >= 0)`,
    ),
    unique('workflow_run_active_admissions_outbox_event_id_key').on(
      table.outboxEventId,
    ),
    foreignKey({
      name: 'workflow_run_active_admissions_outbox_fk',
      columns: [table.outboxEventId],
      foreignColumns: [outboxEvents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_run_active_admissions_run_fk',
      columns: [table.workflowRunId],
      foreignColumns: [workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_run_active_admissions_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('workflow_run_active_admissions_workspace_idx').on(table.workspaceId),
  ],
);

export const workflowRunAdmissionTicketSequence = appSchema.sequence(
  'workflow_run_admission_ticket_seq',
);
