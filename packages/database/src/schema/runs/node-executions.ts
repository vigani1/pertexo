import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import type {
  StoredExecutionValue,
  NodeAttemptLease,
} from '../stored-shapes.js';
import type { RecoveryNode } from '@pertexo/workflow-engine';
import {
  check,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  timestamp,
  type PgTableExtraConfigValue,
  unique,
  uuid,
  varchar,
  bigint,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { workflowRuns } from './workflow-runs.js';
import type { CodeDiagnostics } from '@pertexo/node-sdk';

// The current-attempt and owning-node foreign keys require one initialization module.
export const nodeRuns = appSchema.table(
  'node_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    invocationKey: varchar('invocation_key', {
      length: WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength,
    }).notNull(),
    branchContext: jsonb('branch_context')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar('status', { length: 32 })
      .$type<RecoveryNode['status']>()
      .notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 })
      .$type<RecoveryNode['sideEffectClass']>()
      .notNull(),
    providerIdempotencyKey: varchar('provider_idempotency_key', {
      length: 256,
    }),
    providerDispatchBinding: varchar('provider_dispatch_binding', {
      length: 128,
    }),
    inputRef: json('input_ref').$type<StoredExecutionValue>(),
    outputRef: json('output_ref').$type<StoredExecutionValue>(),
    failureRef: json('failure_ref').$type<StoredExecutionValue>(),
    failureHandlerEntryKey: varchar('failure_handler_entry_key', {
      length: 256,
    }),
    failureHandlerSinkKey: varchar('failure_handler_sink_key', { length: 256 }),
    failureHandling: varchar('failure_handling', { length: 16 }).$type<
      'pending' | 'handled'
    >(),
    currentAttemptId: uuid('current_attempt_id'),
    currentAttemptNumber: integer('current_attempt_number'),
    // No source-node FK: copied values outlive independently retired source details.
    reusedSourceRunId: uuid('reused_source_run_id'),
    reusedSourceNodeRunId: uuid('reused_source_node_run_id'),
    reusedSourceCompletedAt: timestamp('reused_source_completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    resumeAt: timestamp('resume_at', { withTimezone: true, mode: 'date' }),
    retryDueAt: timestamp('retry_due_at', {
      withTimezone: true,
      mode: 'date',
    }),
    dueWakeupAt: timestamp('due_wakeup_at', {
      withTimezone: true,
      mode: 'date',
    }),
    controlKind: varchar('control_kind', { length: 32 }),
    waitKind: varchar('wait_kind', { length: 32 }).$type<
      'node_wait' | 'retry_backoff'
    >(),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'node_runs_failure_handling_complete',
      sql`(((failure_ref IS NULL) AND (failure_handler_entry_key IS NULL) AND (failure_handler_sink_key IS NULL) AND (failure_handling IS NULL)) OR ((failure_ref IS NOT NULL) AND (failure_handler_entry_key IS NOT NULL) AND (failure_handler_sink_key IS NOT NULL) AND (failure_handling IN ('pending', 'handled')) AND (status = 'failed') AND (current_attempt_id IS NOT NULL) AND (current_attempt_number > 0))) IS TRUE`,
    ),
    check(
      'node_runs_failure_ref_bounded',
      sql`failure_ref IS NULL OR octet_length(failure_ref::text) <= 4096`,
    ),
    check(
      'node_runs_attempt_pointer_complete',
      sql`(((current_attempt_id IS NULL) AND (current_attempt_number IS NULL)) OR ((current_attempt_id IS NOT NULL) AND (current_attempt_number IS NOT NULL) AND (current_attempt_number > 0)))`,
    ),
    check(
      'node_runs_reuse_provenance_complete',
      sql`(((reused_source_run_id IS NULL) AND (reused_source_node_run_id IS NULL) AND (reused_source_completed_at IS NULL)) OR ((reused_source_run_id IS NOT NULL) AND (reused_source_node_run_id IS NOT NULL) AND (reused_source_completed_at IS NOT NULL) AND (status = 'succeeded') AND (output_ref IS NOT NULL) AND (current_attempt_id IS NULL) AND (current_attempt_number IS NULL) AND (started_at IS NULL) AND (completed_at IS NULL) AND (control_kind IS NULL) AND (provider_dispatch_binding IS NULL) AND (input_ref IS NULL))) IS TRUE`,
    ),
    check(
      'node_runs_branch_context_bounded',
      sql`(octet_length((branch_context)::text) <= 4096)`,
    ),
    check(
      'node_runs_control_kind_valid',
      sql`((control_kind IS NULL) OR ((control_kind)::text IN ('for_each_barrier'::text, 'workflow_call'::text, 'human_task'::text)))`,
    ),
    check(
      'node_runs_due_wakeup_consistent',
      sql`(((due_wakeup_at IS NULL) OR (((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL) AND (due_wakeup_at = COALESCE(retry_due_at, resume_at)))) IS TRUE)`,
    ),
    check(
      'node_runs_invocation_key_format',
      sql`(((invocation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'::text) OR ((invocation_key)::text ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'::text))`,
    ),
    check(
      'node_runs_node_id_format',
      sql`((node_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)`,
    ),
    check(
      'node_runs_provider_dispatch_binding_format',
      sql`((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'::text))`,
    ),
    check(
      'node_runs_provider_key_bounded',
      sql`((provider_idempotency_key IS NULL) OR (length((provider_idempotency_key)::text) <= 256))`,
    ),
    check(
      'node_runs_provider_key_valid',
      sql`(((side_effect_class)::text = 'idempotent_with_key'::text) = (provider_idempotency_key IS NOT NULL))`,
    ),
    check(
      'node_runs_side_effect_class_valid',
      sql`((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))`,
    ),
    check(
      'node_runs_status_valid',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('ready'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'node_runs_wait_kind_valid',
      sql`((wait_kind IS NULL) OR ((wait_kind)::text = ANY (ARRAY[('node_wait'::character varying)::text, ('retry_backoff'::character varying)::text])))`,
    ),
    check(
      'node_runs_wait_state_valid',
      sql`(((((status)::text = 'waiting'::text) AND ((control_kind)::text IN ('for_each_barrier'::text, 'workflow_call'::text)) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL)) OR (status = 'waiting' AND control_kind = 'human_task' AND wait_kind IS NULL AND resume_at IS NOT NULL AND retry_due_at IS NULL) OR (((status)::text = 'waiting'::text) AND (control_kind IS NULL) AND ((((wait_kind)::text = 'node_wait'::text) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((wait_kind)::text = 'retry_backoff'::text) AND (resume_at IS NULL) AND (retry_due_at IS NOT NULL)))) OR (((status)::text <> 'waiting'::text) AND (control_kind IS NULL) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL))) IS TRUE)`,
    ),
    unique('node_runs_invocation_unique').on(
      table.workflowRunId,
      table.invocationKey,
    ),
    unique('node_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    // The baseline sets this foreign key DEFERRABLE INITIALLY DEFERRED.
    foreignKey({
      name: 'node_runs_current_attempt_workspace_fk',
      columns: [table.workspaceId, table.currentAttemptId],
      foreignColumns: [nodeAttempts.workspaceId, nodeAttempts.id],
    }),
    foreignKey({
      name: 'node_runs_run_workspace_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    // Backs the deferred foreign key above: without it, every deleted attempt
    // scans the workspace's steps when the transaction commits (dm-04).
    index('node_runs_current_attempt_idx')
      .on(table.workspaceId, table.currentAttemptId)
      .where(sql`(current_attempt_id IS NOT NULL)`),
    index('node_runs_run_node_idx').on(
      table.workspaceId,
      table.workflowRunId,
      table.nodeId,
      table.id,
    ),
    index('node_runs_due_idx')
      .on(table.workspaceId, table.retryDueAt, table.resumeAt, table.id)
      .where(sql`((status)::text = 'waiting'::text)`),
    index('node_runs_due_wakeup_idx')
      .on(sql`COALESCE(retry_due_at, resume_at)`, table.id)
      .where(
        sql`(((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL))`,
      ),
    index('node_runs_operator_due_idx')
      .on(
        table.workspaceId,
        table.workflowRunId,
        sql`COALESCE(retry_due_at, resume_at)`,
        table.id,
      )
      .where(sql`((status)::text = 'waiting'::text)`),
    index('node_runs_run_status_idx').on(
      table.workspaceId,
      table.workflowRunId,
      table.status,
      table.id,
    ),
  ],
);

export const nodeAttempts = appSchema.table(
  'node_attempts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    nodeRunId: uuid('node_run_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    status: varchar('status', { length: 32 })
      .$type<RecoveryNode['status']>()
      .notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 })
      .$type<NodeAttemptLease['sideEffectClass']>()
      .notNull(),
    providerIdempotencyKey: varchar('provider_idempotency_key', {
      length: 256,
    }),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    fenceToken: bigint('fence_token', { mode: 'number' }).default(0).notNull(),
    dispatchMarkedAt: timestamp('dispatch_marked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    outputRef: json('output_ref').$type<StoredExecutionValue>(),
    codeDiagnostics: jsonb('code_diagnostics').$type<CodeDiagnostics>(),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    errorSummary: varchar('error_summary', { length: 2048 }),
    executorRetryAfterMillis: integer('executor_retry_after_millis'),
    executorFailureKind: varchar('executor_failure_kind', { length: 32 }).$type<
      NonNullable<RecoveryNode['attempts'][number]['failureKind']>
    >(),
    executorErrorKind: varchar('executor_error_kind', { length: 32 }).$type<
      NonNullable<RecoveryNode['attempts'][number]['errorKind']>
    >(),
    executorPossiblyDispatched: boolean('executor_possibly_dispatched'),
    retryDecision: varchar('retry_decision', { length: 32 }),
    admissionKind: varchar('admission_kind', { length: 32 })
      .$type<NodeAttemptLease['admissionKind']>()
      .notNull()
      .default(sql`'execute'::character varying`),
    reconciliationRef: jsonb('reconciliation_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'node_attempts_code_diagnostics_bound',
      sql`${table.codeDiagnostics} IS NULL OR (jsonb_typeof(${table.codeDiagnostics})='object' AND octet_length(${table.codeDiagnostics}::text)<=1048576)`,
    ),
    check(
      'node_attempts_admission_kind_valid',
      sql`((admission_kind)::text = ANY (ARRAY[('execute'::character varying)::text, ('retry'::character varying)::text, ('wait_resume'::character varying)::text]))`,
    ),
    check(
      'node_attempts_executor_retry_after_valid',
      sql`executor_retry_after_millis IS NULL OR (executor_failure_kind IS NOT NULL AND executor_retry_after_millis BETWEEN 0 AND 60000)`,
    ),
    check(
      'node_attempts_executor_error_kind_valid',
      sql`((executor_error_kind IS NULL) OR ((executor_error_kind)::text = ANY (ARRAY[('authentication'::character varying)::text, ('canceled'::character varying)::text, ('configuration'::character varying)::text, ('internal'::character varying)::text, ('network'::character varying)::text, ('provider'::character varying)::text, ('rate_limit'::character varying)::text, ('timeout'::character varying)::text])))`,
    ),
    check(
      'node_attempts_executor_failure_complete',
      sql`(((executor_failure_kind IS NULL) AND (executor_error_kind IS NULL) AND (executor_possibly_dispatched IS NULL) AND (retry_decision IS NULL)) OR ((executor_failure_kind IS NOT NULL) AND (executor_error_kind IS NOT NULL) AND (executor_possibly_dispatched IS NOT NULL) AND (retry_decision IS NOT NULL)))`,
    ),
    check(
      'node_attempts_executor_failure_kind_valid',
      sql`((executor_failure_kind IS NULL) OR ((executor_failure_kind)::text = ANY (ARRAY[('failed'::character varying)::text, ('canceled'::character varying)::text, ('retry'::character varying)::text, ('outcome_unknown'::character varying)::text])))`,
    ),
    check(
      'node_attempts_executor_failure_only_failed',
      sql`((executor_failure_kind IS NULL) OR ((status)::text = 'failed'::text))`,
    ),
    check('node_attempts_fence_nonnegative', sql`(fence_token >= 0)`),
    check(
      'node_attempts_lease_complete',
      sql`(((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND ((status)::text = 'running'::text)))`,
    ),
    check('node_attempts_number_positive', sql`(attempt_number > 0)`),
    check(
      'node_attempts_provider_key_valid',
      sql`(((side_effect_class)::text = 'idempotent_with_key'::text) = (provider_idempotency_key IS NOT NULL))`,
    ),
    check(
      'node_attempts_reconciliation_ref_bounded',
      sql`((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))`,
    ),
    check(
      'node_attempts_retry_decision_valid',
      sql`((retry_decision IS NULL) OR ((retry_decision)::text = ANY (ARRAY[('pending'::character varying)::text, ('retry'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])))`,
    ),
    check(
      'node_attempts_side_effect_class_valid',
      sql`((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))`,
    ),
    check(
      'node_attempts_status_valid',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('ready'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    unique('node_attempts_number_unique').on(
      table.nodeRunId,
      table.attemptNumber,
    ),
    unique('node_attempts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'node_attempts_node_run_workspace_fk',
      columns: [table.workspaceId, table.nodeRunId],
      foreignColumns: [nodeRuns.workspaceId, nodeRuns.id],
    }).onDelete('cascade'),
    index('node_attempts_expired_lease_idx')
      .on(table.leaseExpiresAt, table.id)
      .where(
        sql`(((status)::text = 'running'::text) AND (lease_expires_at IS NOT NULL))`,
      ),
    index('node_attempts_node_status_idx').on(
      table.workspaceId,
      table.nodeRunId,
      table.status,
      table.attemptNumber,
    ),
    uniqueIndex('node_attempts_one_nonterminal_idx')
      .on(table.nodeRunId)
      .where(
        sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('ready'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text]))`,
      ),
  ],
);
