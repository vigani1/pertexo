import { workspaceExecutionEntitlementVersions } from './entitlements.js';
import { failureNotificationDestinationVersions } from '../notifications.js';
import { users } from '../foundation.js';
import { workflows } from '../authoring/workflows.js';
import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from '../namespace.js';

export const workflowRuns = appSchema.table(
  'workflow_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    replaySourceRunId: uuid('replay_source_run_id'),
    replayCommandId: uuid('replay_command_id'),
    triggerType: varchar('trigger_type', { length: 32 }).notNull(),
    failureNotificationDestinationId: uuid(
      'failure_notification_destination_id',
    ),
    failureNotificationDestinationConfigVersion: integer(
      'failure_notification_destination_config_version',
    ),
    failureNotificationSideEffectClass: varchar(
      'failure_notification_side_effect_class',
      { length: 32 },
    ),
    failureNotificationConnectionSecretVersionId: uuid(
      'failure_notification_connection_secret_version_id',
    ),
    executionEntitlementVersion: integer('execution_entitlement_version'),
    // Assigned by the admission trigger under the workspace counter, never by
    // an application/default sequence call before that serialization lock.
    admissionTicket: bigint('admission_ticket', { mode: 'bigint' })
      .notNull()
      .$defaultFn(() => sql`null`),
    status: varchar('status', { length: 32 }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
    deadlineWakeupAt: timestamp('deadline_wakeup_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cancelRequestedAt: timestamp('cancel_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cancelRequestedBy: varchar('cancel_requested_by', { length: 128 }),
    cancelReason: varchar('cancel_reason', { length: 512 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    inputRef: jsonb('input_ref'),
    inputRefExpiresAt: timestamp('input_ref_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    detailsPurgedAt: timestamp('details_purged_at', {
      withTimezone: true,
      mode: 'date',
    }),
    outputRef: jsonb('output_ref'),
    errorSummary: varchar('error_summary', { length: 2048 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_runs_admission_ticket_positive',
      sql`(admission_ticket > 0)`,
    ),
    check(
      'workflow_runs_cancel_actor_format',
      sql`((cancel_requested_by IS NULL) OR ((cancel_requested_by)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text))`,
    ),
    check(
      'workflow_runs_cancel_metadata_complete',
      sql`(((cancel_requested_at IS NULL) AND (cancel_requested_by IS NULL) AND (cancel_reason IS NULL)) OR ((cancel_requested_at IS NOT NULL) AND (cancel_requested_by IS NOT NULL)))`,
    ),
    check(
      'workflow_runs_deadline_valid',
      sql`((deadline_at IS NULL) OR (deadline_at > created_at))`,
    ),
    check(
      'workflow_runs_deadline_wakeup_consistent',
      sql`(((deadline_wakeup_at IS NULL) OR ((deadline_at IS NOT NULL) AND (deadline_wakeup_at = deadline_at))) IS TRUE)`,
    ),
    check(
      'workflow_runs_failure_notification_policy_complete',
      sql`((((failure_notification_destination_id IS NULL) AND (failure_notification_destination_config_version IS NULL) AND (failure_notification_side_effect_class IS NULL) AND (failure_notification_connection_secret_version_id IS NULL)) OR ((failure_notification_destination_id IS NOT NULL) AND (failure_notification_destination_config_version IS NOT NULL) AND (failure_notification_destination_config_version > 0) AND (failure_notification_side_effect_class IS NOT NULL) AND ((failure_notification_side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[])))) IS TRUE)`,
    ),
    check(
      'workflow_runs_input_ref_bounded',
      sql`((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304))`,
    ),
    check(
      'workflow_runs_input_ref_expiry_valid',
      sql`(((input_ref IS NULL) AND (input_ref_expires_at IS NULL)) OR ((input_ref IS NOT NULL) AND (input_ref_expires_at IS NOT NULL) AND (input_ref_expires_at > created_at) AND (input_ref_expires_at <= (created_at + '30 days'::interval))))`,
    ),
    check(
      'workflow_runs_output_ref_bounded',
      sql`((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))`,
    ),
    check(
      'workflow_runs_replay_lineage_valid',
      sql`(((trigger_type)::text = 'replay'::text) = ((replay_source_run_id IS NOT NULL) AND (replay_command_id IS NOT NULL)))`,
    ),
    check(
      'workflow_runs_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'workflow_runs_trigger_type_valid',
      sql`((trigger_type)::text = ANY (ARRAY[('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text]))`,
    ),
    unique('workflow_runs_failure_notification_pin_unique').on(
      table.workspaceId,
      table.id,
      table.failureNotificationDestinationId,
      table.failureNotificationDestinationConfigVersion,
      table.failureNotificationSideEffectClass,
      table.failureNotificationConnectionSecretVersionId,
    ),
    unique('workflow_runs_replay_command_unique').on(table.replayCommandId),
    unique('workflow_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    unique('workflow_runs_workspace_version_identity_unique').on(
      table.workspaceId,
      table.id,
      table.workflowVersionId,
    ),
    foreignKey({
      name: 'workflow_runs_execution_entitlement_fk',
      columns: [table.workspaceId, table.executionEntitlementVersion],
      foreignColumns: [
        workspaceExecutionEntitlementVersions.workspaceId,
        workspaceExecutionEntitlementVersions.version,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_runs_failure_notification_destination_version_fk',
      columns: [
        table.workspaceId,
        table.failureNotificationDestinationId,
        table.failureNotificationDestinationConfigVersion,
      ],
      foreignColumns: [
        failureNotificationDestinationVersions.workspaceId,
        failureNotificationDestinationVersions.destinationId,
        failureNotificationDestinationVersions.version,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_runs_replay_source_fk',
      columns: [table.workspaceId, table.replaySourceRunId],
      foreignColumns: [table.workspaceId, table.id],
    }),
    index('workflow_runs_detail_retention_idx')
      .on(table.workspaceId, table.completedAt, table.id)
      .where(sql`((completed_at IS NOT NULL) AND (details_purged_at IS NULL))`),
    index('workflow_runs_due_deadline_idx')
      .on(table.deadlineAt, table.id)
      .where(
        sql`((deadline_at IS NOT NULL) AND ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text])) AND (deadline_wakeup_at IS NULL))`,
      ),
    index('workflow_runs_due_input_ref_retention_idx')
      .on(table.workspaceId, table.inputRefExpiresAt, table.id)
      .where(sql`(input_ref IS NOT NULL)`),
    index('workflow_runs_queued_admission_order_idx')
      .on(table.workspaceId, table.workflowId, table.admissionTicket, table.id)
      .where(sql`((status)::text = 'queued'::text)`),
    index('workflow_runs_replay_source_idx')
      .on(table.workspaceId, table.replaySourceRunId, table.id)
      .where(sql`(replay_source_run_id IS NOT NULL)`),
    index('workflow_runs_summary_retention_idx')
      .on(table.workspaceId, table.completedAt, table.id)
      .where(sql`(completed_at IS NOT NULL)`),
    index('workflow_runs_workflow_active_idx')
      .on(table.workspaceId, table.workflowId, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('running'::character varying)::text, ('waiting'::character varying)::text]))`,
      ),
    index('workflow_runs_workflow_version_idx').on(
      table.workspaceId,
      table.workflowVersionId,
      table.id,
    ),
    index('workflow_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    // The baseline adds INCLUDE coverage; drizzle-orm cannot declare it.
    index('workflow_runs_workspace_created_statistics_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    index('workflow_runs_workspace_status_created_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('workflow_runs_workspace_workflow_created_idx').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt,
      table.id,
    ),
  ],
);
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
      sql`((type)::text = ANY (ARRAY[('run.queued'::character varying)::text, ('run.started'::character varying)::text, ('run.waiting'::character varying)::text, ('run.cancel_requested'::character varying)::text, ('run.succeeded'::character varying)::text, ('run.failed'::character varying)::text, ('run.canceled'::character varying)::text, ('run.timed_out'::character varying)::text, ('run.outcome_unknown'::character varying)::text, ('node.ready'::character varying)::text, ('node.started'::character varying)::text, ('node.progress'::character varying)::text, ('node.waiting'::character varying)::text, ('node.retry_scheduled'::character varying)::text, ('node.succeeded'::character varying)::text, ('node.failed'::character varying)::text, ('node.skipped'::character varying)::text, ('node.canceled'::character varying)::text, ('node.timed_out'::character varying)::text, ('node.outcome_unknown'::character varying)::text]))`,
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
export const runCheckpoints = appSchema.table(
  'run_checkpoints',
  {
    workflowRunId: uuid('workflow_run_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    revision: integer('revision').notNull(),
    schedulerState: jsonb('scheduler_state').notNull(),
    resumeAt: timestamp('resume_at', { withTimezone: true, mode: 'date' }),
    resumeLeaseOwner: varchar('resume_lease_owner', { length: 128 }),
    resumeLeaseToken: uuid('resume_lease_token'),
    resumeLeaseExpiresAt: timestamp('resume_lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'run_checkpoints_resume_lease_complete',
      sql`(((resume_lease_owner IS NULL) AND (resume_lease_token IS NULL) AND (resume_lease_expires_at IS NULL)) OR ((resume_lease_owner IS NOT NULL) AND (resume_lease_token IS NOT NULL) AND (resume_lease_expires_at IS NOT NULL)))`,
    ),
    check('run_checkpoints_revision_nonnegative', sql`(revision >= 0)`),
    check(
      'run_checkpoints_scheduler_state_bounded',
      sql`(octet_length((scheduler_state)::text) <= 4194304)`,
    ),
    foreignKey({
      name: 'run_checkpoints_run_version_workspace_fk',
      columns: [
        table.workspaceId,
        table.workflowRunId,
        table.workflowVersionId,
      ],
      foreignColumns: [
        workflowRuns.workspaceId,
        workflowRuns.id,
        workflowRuns.workflowVersionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'run_checkpoints_run_workspace_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    index('run_checkpoints_due_resume_idx')
      .on(table.resumeAt, table.workflowRunId)
      .where(sql`(resume_at IS NOT NULL)`),
  ],
);
export const nodeRuns = appSchema.table(
  'node_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    invocationKey: varchar('invocation_key', { length: 256 }).notNull(),
    branchContext: jsonb('branch_context')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar('status', { length: 32 }).notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 }).notNull(),
    providerIdempotencyKey: varchar('provider_idempotency_key', {
      length: 256,
    }),
    providerDispatchBinding: varchar('provider_dispatch_binding', {
      length: 128,
    }),
    inputRef: jsonb('input_ref'),
    outputRef: jsonb('output_ref'),
    currentAttemptId: uuid('current_attempt_id'),
    currentAttemptNumber: integer('current_attempt_number'),
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
    waitKind: varchar('wait_kind', { length: 32 }),
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
      'node_runs_attempt_pointer_complete',
      sql`(((current_attempt_id IS NULL) AND (current_attempt_number IS NULL)) OR ((current_attempt_id IS NOT NULL) AND (current_attempt_number IS NOT NULL) AND (current_attempt_number > 0)))`,
    ),
    check(
      'node_runs_branch_context_bounded',
      sql`(octet_length((branch_context)::text) <= 4096)`,
    ),
    check(
      'node_runs_control_kind_valid',
      sql`((control_kind IS NULL) OR ((control_kind)::text = 'for_each_barrier'::text))`,
    ),
    check(
      'node_runs_due_wakeup_consistent',
      sql`(((due_wakeup_at IS NULL) OR (((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL) AND (due_wakeup_at = COALESCE(retry_due_at, resume_at)))) IS TRUE)`,
    ),
    check(
      'node_runs_input_ref_bounded',
      sql`((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304))`,
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
      'node_runs_output_ref_bounded',
      sql`((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))`,
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
      sql`(((((status)::text = 'waiting'::text) AND ((control_kind)::text = 'for_each_barrier'::text) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL)) OR (((status)::text = 'waiting'::text) AND (control_kind IS NULL) AND ((((wait_kind)::text = 'node_wait'::text) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((wait_kind)::text = 'retry_backoff'::text) AND (resume_at IS NULL) AND (retry_due_at IS NOT NULL)))) OR (((status)::text <> 'waiting'::text) AND (control_kind IS NULL) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL))) IS TRUE)`,
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
    status: varchar('status', { length: 32 }).notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 }).notNull(),
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
    outputRef: jsonb('output_ref'),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    errorSummary: varchar('error_summary', { length: 2048 }),
    executorFailureKind: varchar('executor_failure_kind', { length: 32 }),
    executorErrorKind: varchar('executor_error_kind', { length: 32 }),
    executorPossiblyDispatched: boolean('executor_possibly_dispatched'),
    retryDecision: varchar('retry_decision', { length: 32 }),
    admissionKind: varchar('admission_kind', { length: 32 })
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
      'node_attempts_admission_kind_valid',
      sql`((admission_kind)::text = ANY (ARRAY[('execute'::character varying)::text, ('retry'::character varying)::text, ('wait_resume'::character varying)::text]))`,
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
      'node_attempts_output_ref_bounded',
      sql`((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))`,
    ),
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
export const previewRuns = appSchema.table(
  'preview_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    draftFingerprint: char('draft_fingerprint', { length: 64 }).notNull(),
    nodeId: varchar('node_id', { length: 256 }).notNull(),
    definitionKey: varchar('definition_key', { length: 128 }).notNull(),
    definitionVersion: integer('definition_version').notNull(),
    executorKey: varchar('executor_key', { length: 128 }).notNull(),
    executorVersion: integer('executor_version').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    idempotencyKeyHash: char('idempotency_key_hash', {
      length: 64,
    }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    traceId: varchar('trace_id', { length: 128 }),
    providerKey: varchar('provider_key', { length: 64 }),
    operationKey: varchar('operation_key', { length: 128 }),
    executableNodeJson: jsonb('executable_node_json').notNull(),
    inputRef: jsonb('input_ref').notNull(),
    priorPreviewRunId: uuid('prior_preview_run_id'),
    sideEffectClass: varchar('side_effect_class', { length: 32 }).notNull(),
    mayContactProvider: boolean('may_contact_provider').notNull(),
    mayCauseExternalSideEffect: boolean(
      'may_cause_external_side_effect',
    ).notNull(),
    dryRun: varchar('dry_run', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).default('queued').notNull(),
    outputRef: jsonb('output_ref'),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    traceparent: varchar('traceparent', { length: 55 }),
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
    check(
      'preview_runs_definition_key_format',
      sql`((definition_key)::text ~ '^[a-z][a-z0-9]*(?:\\.[a-z0-9]+)*$'::text)`,
    ),
    check(
      'preview_runs_disclosure_consistent',
      sql`((may_cause_external_side_effect IS FALSE) OR (may_contact_provider IS TRUE))`,
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
      sql`((executor_key)::text ~ '^[a-z][a-z0-9]*(?:\\.[a-z0-9]+)*$'::text)`,
    ),
    check(
      'preview_runs_idempotency_hashes_format',
      sql`((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'preview_runs_input_bounded',
      sql`(octet_length((input_ref)::text) <= 4194304)`,
    ),
    check(
      'preview_runs_integration_identity_consistent',
      sql`((((provider_key IS NULL) AND (operation_key IS NULL)) OR ((provider_key IS NOT NULL) AND (operation_key IS NOT NULL) AND ((provider_key)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text) AND ((operation_key)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))) IS TRUE)`,
    ),
    check(
      'preview_runs_node_bounded',
      sql`(octet_length((executable_node_json)::text) <= 2097152)`,
    ),
    check(
      'preview_runs_node_id_bounded',
      sql`((length((node_id)::text) >= 1) AND (length((node_id)::text) <= 256))`,
    ),
    check(
      'preview_runs_node_object',
      sql`(jsonb_typeof(executable_node_json) = 'object'::text)`,
    ),
    check(
      'preview_runs_output_bounded',
      sql`((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))`,
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
      sql`(((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL)))`,
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
export const previewAttempts = appSchema.table(
  'preview_attempts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    previewRunId: uuid('preview_run_id').notNull(),
    status: varchar('status', { length: 32 }).default('queued').notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 }).notNull(),
    providerIdempotencyKey: varchar('provider_idempotency_key', {
      length: 256,
    }),
    providerDispatchBinding: varchar('provider_dispatch_binding', {
      length: 128,
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
    outputRef: jsonb('output_ref'),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    reconciliationRef: jsonb('reconciliation_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'preview_attempts_error_code_format',
      sql`((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check('preview_attempts_fence_nonnegative', sql`(fence_token >= 0)`),
    check(
      'preview_attempts_lease_complete',
      sql`(((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))`,
    ),
    check(
      'preview_attempts_lease_owner_format',
      sql`((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))`,
    ),
    check(
      'preview_attempts_output_bounded',
      sql`((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))`,
    ),
    check(
      'preview_attempts_output_truth',
      sql`((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))`,
    ),
    check(
      'preview_attempts_provider_dispatch_binding_format',
      sql`((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'::text))`,
    ),
    check(
      'preview_attempts_provider_key_bounded',
      sql`((provider_idempotency_key IS NULL) OR ((length((provider_idempotency_key)::text) >= 1) AND (length((provider_idempotency_key)::text) <= 256)))`,
    ),
    check(
      'preview_attempts_reconciliation_bounded',
      sql`((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))`,
    ),
    check(
      'preview_attempts_side_effect_class_valid',
      sql`((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))`,
    ),
    check(
      'preview_attempts_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'preview_attempts_terminal_shape',
      sql`((((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text])) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (completed_at IS NOT NULL)))`,
    ),
    check(
      'preview_attempts_time_order',
      sql`(((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL)) AND ((dispatch_marked_at IS NULL) OR (started_at IS NOT NULL)))`,
    ),
    unique('preview_attempts_one_per_run').on(table.previewRunId),
    unique('preview_attempts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'preview_attempts_run_fk',
      columns: [table.workspaceId, table.previewRunId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
    }).onDelete('restrict'),
    index('preview_attempts_claim_idx')
      .on(table.status, table.leaseExpiresAt, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text]))`,
      ),
  ],
);
