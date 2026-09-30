import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema } from './app-schema.js';
import { workflows } from './authoring.js';
import { workflowRuns } from './execution.js';

// ADR 056. String-mode timestamps preserve PostgreSQL precision.

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
  (table) => [
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
    uniqueIndex('workflow_trigger_outcomes_run_unique').on(
      table.workspaceId,
      table.runId,
    ),
    index('workflow_trigger_outcomes_pending_idx').on(
      table.createdAt,
      table.id,
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
    lastRunId: uuid('last_run_id'),
    lastEndedAt: timestamp('last_ended_at', {
      withTimezone: true,
      mode: 'string',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
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
