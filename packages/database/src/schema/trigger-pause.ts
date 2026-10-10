import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema } from './namespace.js';
import { workflows } from './authoring/workflows.js';
import { workflowRuns } from './runs/execution.js';

// ADR 056. String-mode timestamps preserve PostgreSQL precision.
/** Closed pauses remain until workflow/tenant deletion, including disabled schedule lag. */
export const workflowTriggerPausePeriods = appSchema.table(
  'workflow_trigger_pause_periods',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    pauseRevision: bigint('pause_revision', { mode: 'bigint' }).notNull(),
    pausedAt: timestamp('paused_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    resumedAt: timestamp('resumed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_trigger_pause_periods_check',
      sql`(resumed_at >= paused_at)`,
    ),
    check(
      'workflow_trigger_pause_periods_pause_revision_check',
      sql`(pause_revision > 0)`,
    ),
    primaryKey({
      name: 'workflow_trigger_pause_periods_pkey',
      columns: [table.workspaceId, table.workflowId, table.pauseRevision],
    }),
    foreignKey({
      name: 'workflow_trigger_pause_periods_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    // The baseline adds INCLUDE coverage; drizzle-orm cannot declare it.
    index('workflow_trigger_pause_periods_due_idx').on(
      table.workspaceId,
      table.workflowId,
      table.pausedAt.desc().nullsFirst(),
    ),
  ],
);

/** Pending schedule and webhook run outcomes, deleted once folded. */
export const workflowTriggerOutcomes = appSchema.table(
  'workflow_trigger_outcomes',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    runId: uuid('run_id').notNull(),
    countsAsFailure: boolean('counts_as_failure').notNull(),
    endedAt: timestamp('ended_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'workflow_trigger_outcomes_run_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_trigger_outcomes_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    index('workflow_trigger_outcomes_pending_idx').on(
      table.createdAt,
      table.id,
    ),
    uniqueIndex('workflow_trigger_outcomes_run_unique').on(
      table.workspaceId,
      table.runId,
    ),
    index('workflow_trigger_outcomes_workflow_idx').on(
      table.workspaceId,
      table.workflowId,
    ),
  ],
);

/** Each workflow's current run of consecutive failures. */
export const workflowFailureStreaks = appSchema.table(
  'workflow_failure_streaks',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull(),
    resumedAfter: timestamp('resumed_after', {
      withTimezone: true,
      mode: 'string',
    }),
    lastRunId: uuid('last_run_id'),
    lastEndedAt: timestamp('last_ended_at', {
      withTimezone: true,
      mode: 'string',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_failure_streaks_consecutive_failures_check',
      sql`(consecutive_failures >= 0)`,
    ),
    check(
      'workflow_failure_streaks_last_run_valid',
      sql`((last_run_id IS NULL) = (last_ended_at IS NULL))`,
    ),
    primaryKey({
      name: 'workflow_failure_streaks_pkey',
      columns: [table.workspaceId, table.workflowId],
    }),
    foreignKey({
      name: 'workflow_failure_streaks_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);
