import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  () => [],
);

export const authIdentities = appSchema.table(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    issuer: varchar('issuer', { length: 2048 }).notNull(),
    providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
    profileMetadata: jsonb('profile_metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('auth_identities_issuer_subject_unique').on(
      table.issuer,
      table.providerSubject,
    ),
    index('auth_identities_user_idx').on(table.userId, table.id),
  ],
);

export const sessions = appSchema.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    userAgent: varchar('user_agent', { length: 512 }),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_digest_unique').on(table.tokenDigest),
    index('sessions_user_active_idx').on(
      table.userId,
      table.expiresAt,
      table.id,
    ),
    index('sessions_expiry_idx').on(table.expiresAt, table.id),
  ],
);

export const oidcLoginTransactions = appSchema.table(
  'oidc_login_transactions',
  {
    stateDigest: varchar('state_digest', { length: 64 }).primaryKey(),
    codeVerifierCiphertext: text('code_verifier_ciphertext').notNull(),
    codeVerifierNonce: varchar('code_verifier_nonce', {
      length: 128,
    }).notNull(),
    codeVerifierTag: varchar('code_verifier_tag', { length: 256 }).notNull(),
    codeVerifierKeyVersion: varchar('code_verifier_key_version', {
      length: 64,
    }).notNull(),
    nonceCiphertext: text('nonce_ciphertext').notNull(),
    nonceNonce: varchar('nonce_nonce', { length: 128 }).notNull(),
    nonceTag: varchar('nonce_tag', { length: 256 }).notNull(),
    nonceKeyVersion: varchar('nonce_key_version', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('oidc_login_transactions_expiry_idx').on(
      table.expiresAt,
      table.stateDigest,
    ),
  ],
);

export const workspaces = appSchema.table(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    deletionRequestedAt: timestamp('deletion_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletionRequestedBy: uuid('deletion_requested_by'),
    deletionReason: varchar('deletion_reason', { length: 512 }),
    purgeAfter: timestamp('purge_after', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspaces_slug_lower_unique').on(sql`lower(${table.slug})`),
    index('workspaces_status_purge_idx').on(
      table.status,
      table.purgeAfter,
      table.id,
    ),
  ],
);

export const workspaceMemberships = appSchema.table(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: varchar('role', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_memberships_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.userId,
    ),
    index('workspace_memberships_user_idx').on(table.userId, table.workspaceId),
  ],
);

export const auditEvents = appSchema.table(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    action: varchar('action', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: uuid('target_id'),
    requestId: varchar('request_id', { length: 128 }),
    traceId: varchar('trace_id', { length: 128 }),
    metadata: jsonb('metadata').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    index('audit_events_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt,
      table.id,
    ),
    index('audit_events_workspace_target_idx').on(
      table.workspaceId,
      table.targetType,
      table.targetId,
      table.occurredAt,
    ),
  ],
);

export const usageEvents = appSchema.table(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    metadata: jsonb('metadata')
      .default(sql`'{}'::jsonb`)
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'usage_events_workspace_fk',
    }).onDelete('restrict'),
    uniqueIndex('usage_events_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index('usage_events_workspace_period_idx').on(
      table.workspaceId,
      table.occurredAt.desc(),
      table.id,
    ),
    index('usage_events_resource_idx').on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
      table.id,
    ),
  ],
);

export const connections = appSchema.table(
  'connections',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    authType: varchar('auth_type', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    currentSecretVersionId: uuid('current_secret_version_id').notNull(),
    lastTestedAt: timestamp('last_tested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastHealthyAt: timestamp('last_healthy_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('connections_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('connections_active_name_provider_unique')
      .on(table.workspaceId, table.providerKey, sql`lower(${table.name})`)
      .where(sql`${table.status} <> 'revoked'`),
    index('connections_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt.desc(),
      table.id,
    ),
  ],
);

export const connectionSecretVersions = appSchema.table(
  'connection_secret_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    schemaVersion: smallint('schema_version').notNull(),
    kmsKeyReference: varchar('kms_key_reference', { length: 2048 }).notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex(
      'connection_secret_versions_workspace_connection_identity_unique',
    ).on(table.workspaceId, table.connectionId, table.id),
    foreignKey({
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
      name: 'connection_secret_versions_connection_fk',
    }).onDelete('restrict'),
    index('connection_secret_versions_connection_created_idx').on(
      table.workspaceId,
      table.connectionId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
);

export const connectionEvents = appSchema.table(
  'connection_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    actorKind: varchar('actor_kind', { length: 32 }).notNull(),
    actorId: varchar('actor_id', { length: 128 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    traceId: varchar('trace_id', { length: 128 }),
    metadata: jsonb('metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
      name: 'connection_events_connection_fk',
    }).onDelete('restrict'),
    index('connection_events_workspace_time_idx').on(
      table.workspaceId,
      table.createdAt.desc(),
      table.id,
    ),
    index('connection_events_connection_time_idx').on(
      table.workspaceId,
      table.connectionId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
);

export const artifacts = appSchema.table(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    purpose: varchar('purpose', { length: 64 }).notNull(),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    mediaType: varchar('media_type', { length: 255 }).notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    finalizedAt: timestamp('finalized_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('artifacts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('artifacts_storage_key_idx').on(table.storageKey),
    index('artifacts_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.id,
    ),
    index('artifacts_pending_expiry_idx')
      .on(table.workspaceId, table.expiresAt, table.id)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const rlsProbeRecords = appSchema.table(
  'rls_probe_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('rls_probe_records_workspace_idx').on(table.workspaceId, table.id),
  ],
);

export const outboxEvents = appSchema.table(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    jobName: varchar('job_name', { length: 128 }).notNull(),
    schemaVersion: smallint('schema_version').notNull(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    payloadChecksum: varchar('payload_checksum', { length: 64 }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    publishAttempts: integer('publish_attempts').default(0).notNull(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('outbox_events_workspace_idx').on(table.workspaceId, table.id),
  ],
);

export const inboxReceipts = appSchema.table(
  'inbox_receipts',
  {
    consumerName: varchar('consumer_name', { length: 128 }).notNull(),
    messageId: uuid('message_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    payloadChecksum: varchar('payload_checksum', { length: 64 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    uniqueIndex('inbox_receipts_consumer_message_idx').on(
      table.consumerName,
      table.messageId,
    ),
    index('inbox_receipts_workspace_idx').on(
      table.workspaceId,
      table.receivedAt,
    ),
  ],
);

export const transportSecurityAuditFacts = appSchema.table(
  'transport_security_audit_facts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    factType: varchar('fact_type', { length: 64 }).notNull(),
    consumerName: varchar('consumer_name', { length: 128 }).notNull(),
    messageId: uuid('message_id').notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('transport_security_audit_facts_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt,
    ),
    index('transport_security_audit_facts_message_idx').on(
      table.workspaceId,
      table.messageId,
    ),
  ],
);

export const workflowRuns = appSchema.table(
  'workflow_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
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

export const artifactLinks = appSchema.table(
  'artifact_links',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    ownerKind: varchar('owner_kind', { length: 32 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.artifactId,
        table.ownerKind,
        table.ownerId,
      ],
      name: 'artifact_links_identity_unique',
    }),
    foreignKey({
      columns: [table.workspaceId, table.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
      name: 'artifact_links_artifact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
      name: 'artifact_links_preview_run_fk',
    }).onDelete('restrict'),
    index('artifact_links_owner_idx').on(
      table.workspaceId,
      table.ownerKind,
      table.ownerId,
      table.artifactId,
    ),
  ],
);

export const idempotencyRecords = appSchema.table(
  'idempotency_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    scope: varchar('scope', { length: 128 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    resultRef: jsonb('result_ref').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('idempotency_records_active_key_unique').on(
      table.workspaceId,
      table.operation,
      table.scope,
      table.keyHash,
    ),
    index('idempotency_records_expiry_idx').on(table.expiresAt, table.id),
    index('idempotency_records_resource_idx').on(
      table.workspaceId,
      table.resourceId,
    ),
  ],
);

export const workspaceCreationIdempotencyRecords = appSchema.table(
  'workspace_creation_idempotency_records',
  {
    id: uuid('id').primaryKey(),
    actorUserId: uuid('actor_user_id').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    resourceId: uuid('resource_id'),
    resultRef: jsonb('result_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workspace_creation_idempotency_active_key_unique').on(
      table.actorUserId,
      table.operation,
      table.keyHash,
    ),
  ],
);

export const workflows = appSchema.table(
  'workflows',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    lifecycleStatus: varchar('lifecycle_status', { length: 32 })
      .default('active')
      .notNull(),
    activationStatus: varchar('activation_status', { length: 32 })
      .default('inactive')
      .notNull(),
    publishedVersionId: uuid('published_version_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`date_trunc('milliseconds', clock_timestamp())`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workflows_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    index('workflows_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    index('workflows_workspace_name_idx').on(
      table.workspaceId,
      table.name,
      table.id,
    ),
  ],
);

export const workflowDrafts = appSchema.table(
  'workflow_drafts',
  {
    workflowId: uuid('workflow_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
      name: 'workflow_drafts_workflow_workspace_fk',
    }).onDelete('cascade'),
    index('workflow_drafts_workspace_idx').on(
      table.workspaceId,
      table.workflowId,
    ),
  ],
);

export const workflowVersions = appSchema.table(
  'workflow_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    checksum: varchar('checksum', { length: 77 }).notNull(),
    executableSchemaVersion: integer('executable_schema_version'),
    executableJson: jsonb('executable_json'),
    compatibilityReleaseEpoch: integer('compatibility_release_epoch'),
    publishedBy: uuid('published_by').notNull(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('workflow_versions_workspace_identity_unique').on(
      table.workspaceId,
      table.workflowId,
      table.id,
    ),
    uniqueIndex('workflow_versions_number_unique').on(
      table.workflowId,
      table.versionNumber,
    ),
    uniqueIndex('workflow_versions_checksum_unique').on(
      table.workflowId,
      table.checksum,
    ),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
      name: 'workflow_versions_workflow_workspace_fk',
    }),
    index('workflow_versions_workspace_workflow_idx').on(
      table.workspaceId,
      table.workflowId,
      table.versionNumber.desc(),
    ),
  ],
);

export const workflowIntegrationUsage = appSchema.table(
  'workflow_integration_usage',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    operationKey: varchar('operation_key', { length: 128 }).notNull(),
    connectionId: uuid('connection_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'workflow_integration_usage_identity_pk',
      columns: [
        table.workflowVersionId,
        table.providerKey,
        table.operationKey,
        table.connectionId,
      ],
    }),
    foreignKey({
      columns: [table.workspaceId, table.workflowVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
      name: 'workflow_integration_usage_version_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
      name: 'workflow_integration_usage_connection_fk',
    }).onDelete('restrict'),
    index('workflow_integration_usage_impact_idx').on(
      table.workspaceId,
      table.providerKey,
      table.operationKey,
      table.workflowVersionId,
      table.connectionId,
    ),
    index('workflow_integration_usage_connection_idx').on(
      table.workspaceId,
      table.connectionId,
      table.workflowVersionId,
      table.providerKey,
      table.operationKey,
    ),
  ],
);

export const nodeCompatibilityReleases = appSchema.table(
  'node_compatibility_releases',
  {
    epoch: integer('epoch').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    catalogJson: jsonb('catalog_json').notNull(),
    predecessorEpoch: integer('predecessor_epoch'),
    preparedByKind: varchar('prepared_by_kind', { length: 32 }).notNull(),
    preparedBy: varchar('prepared_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.predecessorEpoch],
      foreignColumns: [table.epoch],
      name: 'node_compatibility_releases_predecessor_fk',
    }),
    uniqueIndex('node_compatibility_releases_epoch_fingerprint_unique').on(
      table.epoch,
      table.fingerprint,
    ),
  ],
);

export const nodeCompatibilityPreactivationChecks = appSchema.table(
  'node_compatibility_preactivation_checks',
  {
    checkId: uuid('check_id').primaryKey(),
    deploymentId: varchar('deployment_id', { length: 128 }).notNull(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    roleKind: varchar('role_kind', { length: 16 }).notNull(),
    artifactId: varchar('artifact_id', { length: 128 }).notNull(),
    observedCatalog: jsonb('observed_catalog').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_preactivation_release_fk',
    }),
    uniqueIndex('node_compatibility_preactivation_unique_artifact').on(
      table.deploymentId,
      table.epoch,
      table.fingerprint,
      table.roleKind,
      table.artifactId,
    ),
  ],
);

export const nodeCompatibilityActivationApprovals = appSchema.table(
  'node_compatibility_activation_approvals',
  {
    approvalId: uuid('approval_id').primaryKey(),
    deploymentId: varchar('deployment_id', { length: 128 }).notNull(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    requiredApiArtifacts: jsonb('required_api_artifacts').notNull(),
    requiredWorkerArtifacts: jsonb('required_worker_artifacts').notNull(),
    approvedBy: varchar('approved_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_activation_approvals_release_fk',
    }),
    uniqueIndex('node_compatibility_activation_approvals_deployment_unique').on(
      table.deploymentId,
      table.epoch,
      table.fingerprint,
    ),
  ],
);

export const nodeCompatibilityCurrent = appSchema.table(
  'node_compatibility_current',
  {
    singleton: boolean('singleton').default(true).primaryKey(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    activatedByKind: varchar('activated_by_kind', { length: 32 }).notNull(),
    activatedBy: varchar('activated_by', { length: 128 }).notNull(),
    activatedAt: timestamp('activated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    activationApprovalId: uuid('activation_approval_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_current_release_fk',
    }),
    foreignKey({
      columns: [table.activationApprovalId],
      foreignColumns: [nodeCompatibilityActivationApprovals.approvalId],
      name: 'node_compatibility_current_activation_approval_fk',
    }),
  ],
);

export const nodeCompatibilityActivations = appSchema.table(
  'node_compatibility_activations',
  {
    activationId: uuid('activation_id').primaryKey(),
    approvalId: uuid('approval_id').notNull(),
    predecessorEpoch: integer('predecessor_epoch').notNull(),
    predecessorFingerprint: varchar('predecessor_fingerprint', {
      length: 128,
    }).notNull(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    activatedByKind: varchar('activated_by_kind', { length: 32 }).notNull(),
    activatedBy: varchar('activated_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    activatedAt: timestamp('activated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('node_compatibility_activations_approval_unique').on(
      table.approvalId,
    ),
    foreignKey({
      columns: [table.approvalId],
      foreignColumns: [nodeCompatibilityActivationApprovals.approvalId],
      name: 'node_compatibility_activations_approval_fk',
    }),
    foreignKey({
      columns: [table.predecessorEpoch, table.predecessorFingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_activations_predecessor_fk',
    }),
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_activations_release_fk',
    }),
  ],
);

export const databaseSchema = {
  artifacts,
  auditEvents,
  authIdentities,
  connectionEvents,
  connections,
  connectionSecretVersions,
  idempotencyRecords,
  inboxReceipts,
  nodeAttempts,
  nodeCompatibilityCurrent,
  nodeCompatibilityActivationApprovals,
  nodeCompatibilityActivations,
  nodeCompatibilityPreactivationChecks,
  nodeCompatibilityReleases,
  nodeRuns,
  oidcLoginTransactions,
  outboxEvents,
  previewAttempts,
  previewRuns,
  rlsProbeRecords,
  runCheckpoints,
  runEvents,
  transportSecurityAuditFacts,
  usageEvents,
  sessions,
  users,
  workspaceMemberships,
  workspaces,
  workflowDrafts,
  workflowIntegrationUsage,
  workflowVersions,
  workflows,
  workflowRuns,
  workspaceCreationIdempotencyRecords,
};
