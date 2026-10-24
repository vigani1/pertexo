import type { WorkflowCallOutcome } from '@pertexo/workflow-engine';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  json,
  timestamp,
  type PgTableExtraConfigValue,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflowVersions } from '../authoring/workflows.js';
import { workflowRuns } from './execution.js';

/** Parent-owned identity survives child detail and summary retirement. */
export const workflowCalls = appSchema.table(
  'workflow_calls',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    parentRunId: uuid('parent_run_id').notNull(),
    invocationKey: varchar('invocation_key', { length: 256 }).notNull(),
    targetWorkflowId: uuid('target_workflow_id').notNull(),
    targetVersionId: uuid('target_version_id').notNull(),
    targetChecksum: varchar('target_checksum', { length: 74 }).notNull(),
    inputRef: json('input_ref'),
    inputChecksum: char('input_checksum', { length: 64 }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
    status: varchar('status', { length: 32 })
      .$type<WorkflowCallOutcome['status'] | 'pending' | 'accepted'>()
      .notNull(),
    childRunId: uuid('child_run_id'),
    liveChildRunId: uuid('live_child_run_id'),
    resultRef: json('result_ref'),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    slotLent: boolean('slot_lent').default(false).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    detailsPurgedAt: timestamp('details_purged_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cancelRequestedAt: timestamp('cancel_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cancelAppliedAt: timestamp('cancel_applied_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_calls_status_valid',
      sql`status in ('pending','accepted','refused','succeeded','failed','canceled','timed_out','outcome_unknown')`,
    ),
    check(
      'workflow_calls_live_child_identity_valid',
      sql`live_child_run_id is null or (child_run_id is not null and live_child_run_id = child_run_id)`,
    ),
    check(
      'workflow_calls_values_bounded',
      sql`(input_ref is null or octet_length(input_ref::text) <= 4194304) and (result_ref is null or octet_length(result_ref::text) <= 4194304)`,
    ),
    check(
      'workflow_calls_retired_details_valid',
      sql`details_purged_at is null or (input_ref is null and result_ref is null)`,
    ),
    unique('workflow_calls_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    unique('workflow_calls_invocation_unique').on(
      table.workspaceId,
      table.parentRunId,
      table.invocationKey,
    ),
    unique('workflow_calls_child_unique').on(
      table.workspaceId,
      table.childRunId,
    ),
    foreignKey({
      name: 'workflow_calls_parent_fk',
      columns: [table.workspaceId, table.parentRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_calls_live_child_fk',
      columns: [table.workspaceId, table.liveChildRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_calls_target_version_fk',
      columns: [
        table.workspaceId,
        table.targetWorkflowId,
        table.targetVersionId,
      ],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('restrict'),
    uniqueIndex('workflow_calls_one_loan_per_parent_idx')
      .on(table.workspaceId, table.parentRunId)
      .where(sql`slot_lent`),
    index('workflow_calls_live_child_idx')
      .on(table.workspaceId, table.liveChildRunId)
      .where(sql`live_child_run_id is not null`),
  ],
);
