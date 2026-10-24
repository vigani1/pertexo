import type {
  WorkflowTestSuiteSummary,
  WorkflowTestSuiteDetail,
} from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflowTestSnapshots } from './tests.js';
import { workspaceVariableSetRevisions } from '../variables.js';
export const workflowTestSuites = appSchema.table(
  'workflow_test_suites',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    startedBy: uuid('started_by').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    signature: varchar('signature', { length: 64 }).notNull(),
    variableSetRevision: integer('variable_set_revision'),
    usesConnections: boolean('uses_connections').notNull(),
    caseDurationMs: integer('case_duration_ms').notNull(),
    initialCheckpoint: jsonb('initial_checkpoint').notNull(),
    status: varchar('status', { length: 16 })
      .$type<WorkflowTestSuiteSummary['status']>()
      .notNull()
      .default('running'),
    stopReason: varchar('stop_reason', { length: 64 }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    deadlineAt: timestamp('deadline_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    nextCheckAt: timestamp('next_check_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    unique('workflow_test_suites_workspace_id_key').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'workflow_test_suites_source_fk',
      columns: [table.workspaceId, table.snapshotId],
      foreignColumns: [
        workflowTestSnapshots.workspaceId,
        workflowTestSnapshots.id,
      ],
    }),
    foreignKey({
      name: 'workflow_test_suites_variables_fk',
      columns: [table.workspaceId, table.variableSetRevision],
      foreignColumns: [
        workspaceVariableSetRevisions.workspaceId,
        workspaceVariableSetRevisions.revision,
      ],
    }),
    uniqueIndex('workflow_test_suites_active_starter_key')
      .on(table.workspaceId, table.workflowId, table.startedBy)
      .where(sql`status='running'`),
    index('workflow_test_suites_due_idx')
      .on(table.nextCheckAt, table.id)
      .where(sql`status='running'`),
    index('workflow_test_suites_history_idx').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt,
      table.id,
    ),
    index('workflow_test_suites_expiry_idx').on(table.expiresAt, table.id),
    check(
      'workflow_test_suites_status_valid',
      sql`status in ('running','passed','failed','canceled','error')`,
    ),
    check(
      'workflow_test_suites_duration_valid',
      sql`case_duration_ms between 1 and 300000 AND deadline_at>created_at AND expires_at>deadline_at`,
    ),
    check(
      'workflow_test_suites_signature_valid',
      sql`signature ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'workflow_test_suites_checkpoint_bound',
      sql`jsonb_typeof(initial_checkpoint)='object' AND octet_length(initial_checkpoint::text)<=262144`,
    ),
  ],
);
export const workflowTestSuiteCases = appSchema.table(
  'workflow_test_suite_cases',
  {
    workspaceId: uuid('workspace_id').notNull(),
    suiteId: uuid('suite_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    caseId: uuid('case_id').notNull(),
    caseRevision: integer('case_revision').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    input: text('input').notNull(),
    expectations: text('expectations').notNull(),
    runId: uuid('run_id'),
    status: varchar('status', { length: 16 })
      .$type<WorkflowTestSuiteDetail['cases'][number]['status']>()
      .notNull()
      .default('pending'),
    report: text('report'),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.suiteId, table.ordinal],
      name: 'workflow_test_suite_cases_pkey',
    }),
    foreignKey({
      columns: [table.workspaceId, table.suiteId],
      foreignColumns: [workflowTestSuites.workspaceId, workflowTestSuites.id],
      name: 'workflow_test_suite_cases_suite_fk',
    }).onDelete('cascade'),
    uniqueIndex('workflow_test_suite_cases_one_running')
      .on(table.workspaceId, table.suiteId)
      .where(sql`status='running'`),
    uniqueIndex('workflow_test_suite_cases_run_key')
      .on(table.workspaceId, table.runId)
      .where(sql`run_id is not null`),
    check(
      'workflow_test_suite_cases_ordinal_valid',
      sql`ordinal between 0 and 49 AND case_revision>0`,
    ),
    check(
      'workflow_test_suite_cases_status_valid',
      sql`status in ('pending','running','passed','failed','error','skipped')`,
    ),
    check(
      'workflow_test_suite_cases_payload_bound',
      sql`octet_length(input)<=65536 AND input::jsonb is not null AND octet_length(expectations)<=16384 AND jsonb_typeof(expectations::jsonb)='object'`,
    ),
    check(
      'workflow_test_suite_cases_report_bound',
      sql`report is null OR (octet_length(report)<=262144 AND jsonb_typeof(report::jsonb)='object')`,
    ),
  ],
);
