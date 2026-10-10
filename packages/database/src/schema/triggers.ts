import { users } from './foundation.js';
import { workflowTriggers } from './authoring/workflows.js';
import { workflowRuns } from './runs/execution.js';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './namespace.js';

export const webhookTriggerSecretVersions = appSchema.table(
  'webhook_trigger_secret_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    purpose: varchar('purpose', { length: 32 })
      .notNull()
      .default(sql`'webhook_hmac_sha256'::character varying`),
    kmsKeyReference: varchar('kms_key_reference', { length: 2048 }).notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_trigger_secret_versions_purpose_valid',
      sql`((purpose)::text = 'webhook_hmac_sha256'::text)`,
    ),
    unique('webhook_trigger_secret_versions_trigger_identity_unique').on(
      table.workspaceId,
      table.triggerId,
      table.id,
    ),
    foreignKey({
      name: 'webhook_trigger_secret_versions_creator_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_secret_versions_trigger_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [workflowTriggers.workspaceId, workflowTriggers.id],
    }).onDelete('restrict'),
  ],
);
export const webhookTriggerEndpoints = appSchema.table(
  'webhook_trigger_endpoints',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    endpointKeyHash: char('endpoint_key_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 })
      .notNull()
      .default(sql`'active'::character varying`),
    currentSecretVersionId: uuid('current_secret_version_id').notNull(),
    previousSecretVersionId: uuid('previous_secret_version_id'),
    previousSecretValidUntil: timestamp('previous_secret_valid_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_trigger_endpoints_hash_valid',
      sql`(endpoint_key_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'webhook_trigger_endpoints_rotation_valid',
      sql`(((previous_secret_version_id IS NULL) AND (previous_secret_valid_until IS NULL)) OR ((previous_secret_version_id IS NOT NULL) AND (previous_secret_valid_until IS NOT NULL) AND (previous_secret_version_id <> current_secret_version_id)))`,
    ),
    check(
      'webhook_trigger_endpoints_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    unique('webhook_trigger_endpoints_endpoint_key_hash_key').on(
      table.endpointKeyHash,
    ),
    unique('webhook_trigger_endpoints_trigger_id_key').on(table.triggerId),
    unique('webhook_trigger_endpoints_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'webhook_trigger_endpoints_current_secret_fk',
      columns: [
        table.workspaceId,
        table.triggerId,
        table.currentSecretVersionId,
      ],
      foreignColumns: [
        webhookTriggerSecretVersions.workspaceId,
        webhookTriggerSecretVersions.triggerId,
        webhookTriggerSecretVersions.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_endpoints_previous_secret_fk',
      columns: [
        table.workspaceId,
        table.triggerId,
        table.previousSecretVersionId,
      ],
      foreignColumns: [
        webhookTriggerSecretVersions.workspaceId,
        webhookTriggerSecretVersions.triggerId,
        webhookTriggerSecretVersions.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_endpoints_trigger_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [workflowTriggers.workspaceId, workflowTriggers.id],
    }).onDelete('restrict'),
  ],
);
export const webhookTriggerDeliveries = appSchema.table(
  'webhook_trigger_deliveries',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    dedupeKind: varchar('dedupe_kind', { length: 16 }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()+interval '90 days'`)
      .notNull(),
    outcome: varchar('outcome', { length: 32 }).default('accepted').notNull(),
    httpStatus: smallint('http_status').default(202).notNull(),
    signatureCheck: varchar('signature_check', { length: 16 })
      .default('verified')
      .notNull(),
    replayCheck: varchar('replay_check', { length: 16 })
      .default('new')
      .notNull(),
    bodyBytes: integer('body_bytes'),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_trigger_deliveries_body_bytes_valid',
      sql`((body_bytes IS NULL) OR ((body_bytes >= 0) AND (body_bytes <= 262144)))`,
    ),
    check(
      'webhook_trigger_deliveries_dedupe_valid',
      sql`((dedupe_kind)::text = ANY (ARRAY[('keyed'::character varying)::text, ('fingerprint'::character varying)::text]))`,
    ),
    check(
      'webhook_trigger_deliveries_outcome_valid',
      sql`((((outcome)::text = 'accepted'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR (((outcome)::text = 'replayed'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'duplicate'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR ((workflow_run_id IS NULL) AND ((((outcome)::text = 'authentication_failed'::text) AND (http_status = 401) AND ((((signature_check)::text = 'not_checked'::text) AND ((replay_check)::text = 'stale_timestamp'::text)) OR (((signature_check)::text = 'mismatch'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))) OR (((outcome)::text = 'invalid_request'::text) AND (http_status = 400) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((outcome)::text = 'conflict'::text) AND (http_status = 409) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'conflict'::text)) OR (((outcome)::text = 'rate_limited'::text) AND (http_status = 429) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)) OR (((outcome)::text = 'paused'::text) AND (http_status = 423) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))))`,
    ),
    check(
      'webhook_trigger_deliveries_retention_valid',
      sql`((expires_at >= (received_at + '89 days 23:59:59'::interval)) AND (expires_at <= (received_at + '90 days 00:00:01'::interval)))`,
    ),
    unique('webhook_trigger_deliveries_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'webhook_trigger_deliveries_endpoint_fk',
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_deliveries_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_deliveries_trigger_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [workflowTriggers.workspaceId, workflowTriggers.id],
    }).onDelete('restrict'),
    index('webhook_deliveries_retention_dry_run_idx').on(
      table.workspaceId,
      table.expiresAt,
      table.id,
    ),
    index('webhook_deliveries_run_retention_idx')
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`(workflow_run_id IS NOT NULL)`),
    index('webhook_trigger_deliveries_expiry_idx').on(
      table.expiresAt,
      table.id,
    ),
    index('webhook_trigger_deliveries_trigger_time_idx').on(
      table.workspaceId,
      table.triggerId,
      table.receivedAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);
export const webhookEndpointIngressLimits = appSchema.table(
  'webhook_endpoint_ingress_limits',
  {
    endpointId: uuid('endpoint_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bucketStartedAt: timestamp('bucket_started_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    requestCount: integer('request_count').notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_endpoint_ingress_limits_count_valid',
      sql`((request_count >= 1) AND (request_count <= 60))`,
    ),
    foreignKey({
      name: 'webhook_endpoint_ingress_limits_endpoint_fk',
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('cascade'),
  ],
);
export const webhookTriggerReplayRecords = appSchema.table(
  'webhook_trigger_replay_records',
  {
    workspaceId: uuid('workspace_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    dedupeKind: varchar('dedupe_kind', { length: 16 }).notNull(),
    dedupeKeyHash: char('dedupe_key_hash', { length: 64 }).notNull(),
    requestFingerprint: char('request_fingerprint', {
      length: 64,
    }).notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_trigger_replay_records_expiry_valid',
      sql`(expires_at > created_at)`,
    ),
    check(
      'webhook_trigger_replay_records_hashes_valid',
      sql`((dedupe_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'webhook_trigger_replay_records_kind_valid',
      sql`((dedupe_kind)::text = ANY (ARRAY[('keyed'::character varying)::text, ('fingerprint'::character varying)::text]))`,
    ),
    check(
      'webhook_trigger_replay_retention_valid',
      sql`((((dedupe_kind)::text = 'fingerprint'::text) AND (expires_at >= (created_at + '00:04:59'::interval)) AND (expires_at <= (created_at + '00:05:01'::interval))) OR (((dedupe_kind)::text = 'keyed'::text) AND (expires_at >= (created_at + '23:59:59'::interval)) AND (expires_at <= (created_at + '24:00:01'::interval))))`,
    ),
    primaryKey({
      name: 'webhook_trigger_replay_records_pkey',
      columns: [table.endpointId, table.dedupeKind, table.dedupeKeyHash],
    }),
    // The baseline sets this foreign key DEFERRABLE INITIALLY DEFERRED.
    foreignKey({
      name: 'webhook_trigger_replay_records_delivery_fk',
      columns: [table.workspaceId, table.deliveryId],
      foreignColumns: [
        webhookTriggerDeliveries.workspaceId,
        webhookTriggerDeliveries.id,
      ],
    }),
    foreignKey({
      name: 'webhook_trigger_replay_records_endpoint_fk',
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_replay_records_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    index('webhook_replay_delivery_retention_idx')
      .on(table.workspaceId, table.deliveryId, table.expiresAt)
      .where(sql`(delivery_id IS NOT NULL)`),
    index('webhook_replay_retention_dry_run_idx').on(
      table.workspaceId,
      table.expiresAt,
      table.endpointId,
      table.dedupeKind,
      table.dedupeKeyHash,
    ),
    index('webhook_replay_run_retention_idx')
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`(workflow_run_id IS NOT NULL)`),
    index('webhook_trigger_replay_records_expiry_idx').on(
      table.expiresAt,
      table.endpointId,
    ),
  ],
);
export const triggerSchedules = appSchema.table(
  'trigger_schedules',
  {
    triggerId: uuid('trigger_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    recurrenceKind: varchar('recurrence_kind', { length: 16 }).notNull(),
    cronExpression: varchar('cron_expression', { length: 256 }),
    timezone: varchar('timezone', { length: 128 }),
    intervalMinutes: integer('interval_minutes'),
    misfirePolicy: varchar('misfire_policy', { length: 32 }).notNull(),
    configFingerprint: varchar('config_fingerprint', { length: 79 }).notNull(),
    anchorAt: timestamp('anchor_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    nextFireAt: timestamp('next_fire_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastFireAt: timestamp('last_fire_at', { withTimezone: true, mode: 'date' }),
    status: varchar('status', { length: 16 })
      .notNull()
      .default(sql`'enabled'::character varying`),
    healthStatus: varchar('health_status', { length: 32 })
      .notNull()
      .default(sql`'healthy'::character varying`),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseAcquiredAt: timestamp('lease_acquired_at', {
      withTimezone: true,
      mode: 'date',
    }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    admissionDeferredUntil: timestamp('admission_deferred_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'trigger_schedules_cursor_valid',
      sql`((last_fire_at IS NULL) OR (last_fire_at < next_fire_at))`,
    ),
    check(
      'trigger_schedules_fingerprint_valid',
      sql`((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$'::text)`,
    ),
    check(
      'trigger_schedules_health_valid',
      sql`((health_status)::text = ANY (ARRAY[('healthy'::character varying)::text, ('degraded'::character varying)::text, ('unhealthy'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    check(
      'trigger_schedules_lease_valid',
      sql`((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)`,
    ),
    check(
      'trigger_schedules_misfire_valid',
      sql`((misfire_policy)::text = ANY (ARRAY[('catch_up_once'::character varying)::text, ('skip'::character varying)::text]))`,
    ),
    check(
      'trigger_schedules_recurrence_valid',
      sql`(((((recurrence_kind)::text = 'cron'::text) AND (cron_expression IS NOT NULL) AND (timezone IS NOT NULL) AND (interval_minutes IS NULL)) OR (((recurrence_kind)::text = 'interval'::text) AND (cron_expression IS NULL) AND (timezone IS NULL) AND (interval_minutes IS NOT NULL) AND ((interval_minutes >= 1) AND (interval_minutes <= 43200)))) IS TRUE)`,
    ),
    check(
      'trigger_schedules_status_valid',
      sql`((status)::text = ANY (ARRAY[('enabled'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    unique('trigger_schedules_workspace_identity_unique').on(
      table.workspaceId,
      table.triggerId,
    ),
    foreignKey({
      name: 'trigger_schedules_trigger_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [workflowTriggers.workspaceId, workflowTriggers.id],
    }).onDelete('restrict'),
    index('trigger_schedules_due_idx')
      .on(table.nextFireAt, table.workspaceId, table.triggerId)
      .where(sql`((status)::text = 'enabled'::text)`),
  ],
);
export const triggerScheduleOccurrences = appSchema.table(
  'trigger_schedule_occurrences',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    scheduledAt: timestamp('scheduled_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    disposition: varchar('disposition', { length: 16 }).notNull(),
    workflowRunId: uuid('workflow_run_id'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'trigger_schedule_occurrences_disposition_valid',
      sql`((((disposition)::text = 'accepted'::text) AND (workflow_run_id IS NOT NULL)) OR (((disposition)::text = ANY (ARRAY[('skipped'::character varying)::text, ('paused'::character varying)::text])) AND (workflow_run_id IS NULL)))`,
    ),
    unique('trigger_schedule_occurrences_identity_unique').on(
      table.triggerId,
      table.scheduledAt,
    ),
    unique('trigger_schedule_occurrences_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'trigger_schedule_occurrences_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'trigger_schedule_occurrences_schedule_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [
        triggerSchedules.workspaceId,
        triggerSchedules.triggerId,
      ],
    }).onDelete('restrict'),
    index('schedule_occurrences_retention_dry_run_idx').on(
      table.workspaceId,
      table.scheduledAt,
      table.id,
    ),
    index('schedule_occurrences_run_retention_idx')
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`(workflow_run_id IS NOT NULL)`),
    index('trigger_schedule_occurrences_trigger_time_idx').on(
      table.workspaceId,
      table.triggerId,
      table.scheduledAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);
