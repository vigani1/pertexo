import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from '../app-schema.js';
import { workflowVersions } from '../authoring/workflows.js';
import { nodeAttempts, workflowRuns } from './execution.js';
import { workspaces } from '../foundation.js';

export const operatorCommands = appSchema.table(
  'operator_commands',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    commandType: varchar('command_type', { length: 64 }).notNull(),
    dryRun: boolean('dry_run').notNull(),
    requestFingerprint: char('request_fingerprint', { length: 64 }).notNull(),
    status: varchar({ length: 16 }).notNull(),
    outcome: varchar({ length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }).default(sql`clock_timestamp()`),
    result: jsonb().notNull(),
  },
  (table) => [
    check(
      'operator_commands_completion_order',
      sql`((((status)::text = 'pending'::text) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('completed'::character varying)::text, ('failed'::character varying)::text])) AND (completed_at IS NOT NULL) AND (completed_at >= created_at))) IS TRUE`,
    ),
    check(
      'operator_commands_fingerprint_valid',
      sql`request_fingerprint ~ '^[0-9a-f]{64}$'::text`,
    ),
    check(
      'operator_commands_outcome_valid',
      sql`(outcome)::text ~ '^[a-z][a-z0-9_]{0,31}$'::text`,
    ),
    check(
      'operator_commands_result_valid',
      sql`(jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 16384)`,
    ),
    check(
      'operator_commands_status_valid',
      sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])`,
    ),
    check(
      'operator_commands_type_valid',
      sql`command_type IN ('outbox.redispatch', 'attempt.reconcile', 'due-work.resume', 'unknown-outcome.record-evidence', 'run.cancel', 'run.replay', 'trigger.reconcile')`,
    ),
    index('operator_commands_workspace_idx').on(table.workspaceId),
    foreignKey({
      name: 'operator_commands_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }),
  ],
);

export const operatorRunReplayRequests = appSchema.table(
  'operator_run_replay_requests',
  {
    commandId: uuid('command_id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    sourceRunId: uuid('source_run_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    runInput: jsonb('run_input').notNull(),
    requestFingerprint: char('request_fingerprint', { length: 64 }).notNull(),
    status: varchar({ length: 16 }).default('pending').notNull(),
    resultRunId: uuid('result_run_id'),
    safeErrorCode: varchar('safe_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    check(
      'operator_run_replay_completion_valid',
      sql`(((status)::text = 'pending'::text) AND (result_run_id IS NULL) AND (safe_error_code IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (result_run_id IS NOT NULL) AND (safe_error_code IS NULL) AND (completed_at IS NOT NULL)) OR (((status)::text = 'failed'::text) AND (result_run_id IS NULL) AND (safe_error_code IS NOT NULL) AND (completed_at IS NOT NULL))`,
    ),
    check(
      'operator_run_replay_fingerprint_valid',
      sql`request_fingerprint ~ '^[0-9a-f]{64}$'::text`,
    ),
    check(
      'operator_run_replay_input_bounded',
      sql`octet_length((run_input)::text) <= 65536`,
    ),
    check(
      'operator_run_replay_status_valid',
      sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])`,
    ),
    // DEFERRABLE INITIALLY DEFERRED in SQL; drizzle-orm cannot declare it.
    foreignKey({
      name: 'operator_run_replay_requests_command_id_fkey',
      columns: [table.commandId],
      foreignColumns: [operatorCommands.id],
    }),
    foreignKey({
      name: 'operator_run_replay_result_fk',
      columns: [table.workspaceId, table.resultRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'operator_run_replay_source_fk',
      columns: [table.workspaceId, table.sourceRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'operator_run_replay_version_fk',
      columns: [table.workspaceId, table.workflowVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
    }).onDelete('cascade'),
  ],
);

export const operatorUnknownOutcomeEvidence = appSchema.table(
  'operator_unknown_outcome_evidence',
  {
    commandId: uuid('command_id').primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    evidenceKind: varchar('evidence_kind', { length: 64 }).notNull(),
    evidenceRef: jsonb('evidence_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    check(
      'operator_unknown_evidence_kind_valid',
      sql`(evidence_kind)::text ~ '^[a-z][a-z0-9_.-]{0,63}$'::text`,
    ),
    check(
      'operator_unknown_evidence_ref_valid',
      sql`(jsonb_typeof(evidence_ref) = 'object'::text) AND (octet_length((evidence_ref)::text) <= 4096)`,
    ),
    foreignKey({
      name: 'operator_unknown_evidence_attempt_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [nodeAttempts.workspaceId, nodeAttempts.id],
    }).onDelete('cascade'),
  ],
);
