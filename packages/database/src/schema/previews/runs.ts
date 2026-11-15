import { TRACEPARENT_CHARACTERS } from '@pertexo/workflow-model';
import { SHA256_HEX_CHARACTERS } from '../column-widths.js';
import type { PreviewAttemptLease, PreviewStatus } from '../stored-shapes.js';
import {
  NODE_IDENTITY_KEY_PATTERN,
  NODE_FAILURE_FIELD_LIMITS,
} from '@pertexo/node-sdk';
import { workspaceVariableSetRevisions } from '../variables.js';
import { users } from '../identity/users.js';
import { workflows } from '../authoring/workflows.js';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  json,
  timestamp,
  type PgTableExtraConfigValue,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

const WIDTHS = Object.freeze({
  draftFingerprint: SHA256_HEX_CHARACTERS,
  nodeId: 256,
  // Both keys are held to NODE_IDENTITY_KEY_MAX_CHARACTERS (64) before they are
  // stored; the columns stay wider, since narrowing needs a migration and gains nothing.
  definitionKey: 128,
  executorKey: 128,
  idempotencyKeyHash: SHA256_HEX_CHARACTERS,
  requestHash: SHA256_HEX_CHARACTERS,
  requestId: 128,
  traceId: 128,
  providerKey: 64,
  operationKey: 128,
  sideEffectClass: 32,
  dryRun: 32,
  status: 32,
  safeErrorCode: NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters,
  traceparent: TRACEPARENT_CHARACTERS,
});

export const previewRuns = appSchema.table(
  'preview_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    draftFingerprint: char('draft_fingerprint', {
      length: WIDTHS.draftFingerprint,
    }).notNull(),
    nodeId: varchar('node_id', { length: WIDTHS.nodeId }).notNull(),
    definitionKey: varchar('definition_key', {
      length: WIDTHS.definitionKey,
    }).notNull(),
    definitionVersion: integer('definition_version').notNull(),
    executorKey: varchar('executor_key', {
      length: WIDTHS.executorKey,
    }).notNull(),
    executorVersion: integer('executor_version').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    idempotencyKeyHash: char('idempotency_key_hash', {
      length: WIDTHS.idempotencyKeyHash,
    }).notNull(),
    requestHash: char('request_hash', { length: WIDTHS.requestHash }).notNull(),
    requestId: varchar('request_id', { length: WIDTHS.requestId }),
    traceId: varchar('trace_id', { length: WIDTHS.traceId }),
    providerKey: varchar('provider_key', { length: WIDTHS.providerKey }),
    operationKey: varchar('operation_key', { length: WIDTHS.operationKey }),
    executableNodeJson: json('executable_node_json').notNull(),
    variableSetRevision: integer('variable_set_revision'),
    inputRef: json('input_ref').notNull(),
    priorPreviewRunId: uuid('prior_preview_run_id'),
    sideEffectClass: varchar('side_effect_class', {
      length: WIDTHS.sideEffectClass,
    })
      .$type<PreviewAttemptLease['sideEffectClass']>()
      .notNull(),
    mayContactProvider: boolean('may_contact_provider').notNull(),
    mayCauseExternalSideEffect: boolean(
      'may_cause_external_side_effect',
    ).notNull(),
    dryRun: varchar('dry_run', { length: WIDTHS.dryRun })
      .$type<PreviewAttemptLease['dryRun']>()
      .notNull(),
    status: varchar('status', { length: WIDTHS.status })
      .$type<PreviewStatus>()
      .default('queued')
      .notNull(),
    outputRef: json('output_ref'),
    pinnedSampleId: uuid('pinned_sample_id'),
    safeErrorCode: varchar('safe_error_code', { length: WIDTHS.safeErrorCode }),
    traceparent: varchar('traceparent', { length: WIDTHS.traceparent }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    executionDeadlineAt: timestamp('execution_deadline_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'preview_runs_variable_set_fk',
      columns: [table.workspaceId, table.variableSetRevision],
      foreignColumns: [
        workspaceVariableSetRevisions.workspaceId,
        workspaceVariableSetRevisions.revision,
      ],
    }),
    index('preview_runs_variable_set_idx')
      .on(table.workspaceId, table.variableSetRevision)
      .where(sql`variable_set_revision IS NOT NULL`),
    check(
      'preview_runs_pinned_sample_valid',
      sql`pinned_sample_id IS NULL OR (status='succeeded' AND side_effect_class='safe' AND may_contact_provider=false AND may_cause_external_side_effect=false AND started_at IS NULL AND completed_at IS NOT NULL)`,
    ),
    check(
      'preview_runs_definition_key_format',
      sql`definition_key ~ ${sql.raw('$node_key$' + NODE_IDENTITY_KEY_PATTERN + '$node_key$')}`,
    ),
    check(
      'preview_runs_draft_fingerprint_format',
      sql`(draft_fingerprint ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'preview_runs_dry_run_valid',
      sql`((dry_run)::text = ANY (ARRAY[('not_supported'::character varying)::text, ('provider_supported'::character varying)::text]))`,
    ),
    check(
      'preview_runs_execution_deadline_order',
      sql`((execution_deadline_at > created_at) AND (execution_deadline_at <= expires_at))`,
    ),
    check(
      'preview_runs_executor_key_format',
      sql`executor_key ~ ${sql.raw('$node_key$' + NODE_IDENTITY_KEY_PATTERN + '$node_key$')}`,
    ),
    check(
      'preview_runs_idempotency_hashes_format',
      sql`((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'preview_runs_integration_identity_consistent',
      sql`((((provider_key IS NULL) AND (operation_key IS NULL)) OR ((provider_key IS NOT NULL) AND (operation_key IS NOT NULL) AND ((provider_key)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text) AND ((operation_key)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))) IS TRUE)`,
    ),
    check(
      'preview_runs_node_id_bounded',
      sql`((length((node_id)::text) >= 1) AND (length((node_id)::text) <= 256))`,
    ),
    check(
      'preview_runs_node_object',
      sql`(json_typeof(executable_node_json) = 'object'::text)`,
    ),
    check(
      'preview_runs_output_truth',
      sql`((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))`,
    ),
    check('preview_runs_retention_future', sql`(expires_at > created_at)`),
    check('preview_runs_revision_positive', sql`(draft_revision > 0)`),
    check(
      'preview_runs_safe_error_code_format',
      sql`((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check(
      'preview_runs_side_effect_class_valid',
      sql`((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))`,
    ),
    check(
      'preview_runs_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'preview_runs_terminal_shape',
      sql`((((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text])) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (completed_at IS NOT NULL)))`,
    ),
    check(
      'preview_runs_time_order',
      sql`(((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL) OR (pinned_sample_id IS NOT NULL)))`,
    ),
    check(
      'preview_runs_traceparent_format',
      sql`((traceparent IS NULL) OR ((traceparent)::text ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'::text))`,
    ),
    check(
      'preview_runs_versions_positive',
      sql`((definition_version > 0) AND (executor_version > 0))`,
    ),
    unique('preview_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    unique('preview_runs_workspace_workflow_identity_unique').on(
      table.workspaceId,
      table.workflowId,
      table.id,
    ),
    foreignKey({
      name: 'preview_runs_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'preview_runs_prior_preview_fk',
      columns: [table.workspaceId, table.workflowId, table.priorPreviewRunId],
      foreignColumns: [table.workspaceId, table.workflowId, table.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'preview_runs_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
    index('preview_runs_unfinished_deadline_idx')
      .on(table.executionDeadlineAt, table.id)
      .where(sql`${table.status} in ('queued','running')`),
    index('preview_runs_expiry_idx').on(table.expiresAt, table.id),
    index('preview_runs_workflow_created_idx').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt.desc().nullsFirst(),
      table.id,
    ),
    index('preview_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);
