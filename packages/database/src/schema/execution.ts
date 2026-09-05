import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';

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
    failureNotificationPolicyVersion: smallint(
      'failure_notification_policy_version',
    ),
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
  (table) => [
    uniqueIndex('workflow_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    index('workflow_runs_workspace_status_created_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('workflow_runs_workflow_version_idx').on(
      table.workspaceId,
      table.workflowVersionId,
      table.id,
    ),
    index('workflow_runs_due_input_ref_retention_idx')
      .on(table.workspaceId, table.inputRefExpiresAt, table.id)
      .where(sql`${table.inputRef} is not null`),
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
  (table) => [
    primaryKey({ columns: [table.workflowRunId, table.sequence] }),
    index('run_events_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
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
    lastTransitionFingerprint: varchar('last_transition_fingerprint', {
      length: 64,
    }),
    revision: integer('revision').notNull(),
    engineVersion: varchar('engine_version', { length: 64 }).notNull(),
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
  (table) => [
    index('run_checkpoints_due_resume_idx').on(
      table.resumeAt,
      table.workflowRunId,
    ),
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
    branchContext: jsonb('branch_context').notNull(),
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
  (table) => [
    uniqueIndex('node_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('node_runs_invocation_unique').on(
      table.workflowRunId,
      table.invocationKey,
    ),
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
    admissionKind: varchar('admission_kind', { length: 32 }).notNull(),
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
  (table) => [
    uniqueIndex('node_attempts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('node_attempts_number_unique').on(
      table.nodeRunId,
      table.attemptNumber,
    ),
    index('node_attempts_node_status_idx').on(
      table.workspaceId,
      table.nodeRunId,
      table.status,
      table.attemptNumber,
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
    draftFingerprint: varchar('draft_fingerprint', { length: 64 }).notNull(),
    nodeId: varchar('node_id', { length: 256 }).notNull(),
    definitionKey: varchar('definition_key', { length: 128 }).notNull(),
    definitionVersion: integer('definition_version').notNull(),
    executorKey: varchar('executor_key', { length: 128 }).notNull(),
    executorVersion: integer('executor_version').notNull(),
    compatibilityReleaseEpoch: integer('compatibility_release_epoch').notNull(),
    compatibilityReleaseFingerprint: varchar(
      'compatibility_release_fingerprint',
      { length: 128 },
    ).notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    idempotencyKeyHash: varchar('idempotency_key_hash', {
      length: 64,
    }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
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
      .defaultNow()
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
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('preview_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('preview_runs_workspace_workflow_identity_unique').on(
      table.workspaceId,
      table.workflowId,
      table.id,
    ),
    index('preview_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt.desc(),
      table.id,
    ),
    index('preview_runs_workflow_created_idx').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt.desc(),
      table.id,
    ),
    index('preview_runs_expiry_idx').on(table.expiresAt, table.id),
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
  (table) => [
    uniqueIndex('preview_attempts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('preview_attempts_one_per_run').on(table.previewRunId),
    index('preview_attempts_claim_idx')
      .on(table.status, table.leaseExpiresAt, table.id)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);
