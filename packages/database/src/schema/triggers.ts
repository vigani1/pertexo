import {
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';

export const webhookTriggerSecretVersions = appSchema.table(
  'webhook_trigger_secret_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    purpose: varchar('purpose', { length: 32 }).notNull(),
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
    uniqueIndex('webhook_trigger_secret_versions_trigger_identity_unique').on(
      table.workspaceId,
      table.triggerId,
      table.id,
    ),
  ],
);
export const webhookTriggerEndpoints = appSchema.table(
  'webhook_trigger_endpoints',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    endpointKeyHash: varchar('endpoint_key_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    currentSecretVersionId: uuid('current_secret_version_id').notNull(),
    previousSecretVersionId: uuid('previous_secret_version_id'),
    previousSecretValidUntil: timestamp('previous_secret_valid_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('webhook_trigger_endpoints_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('webhook_trigger_endpoints_trigger_unique').on(table.triggerId),
    uniqueIndex('webhook_trigger_endpoints_key_hash_unique').on(
      table.endpointKeyHash,
    ),
  ],
);
export const webhookTriggerDeliveries = appSchema.table(
  'webhook_trigger_deliveries',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    workflowRunId: uuid('workflow_run_id').notNull(),
    dedupeKind: varchar('dedupe_kind', { length: 16 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()+interval '90 days'`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('webhook_trigger_deliveries_workspace_identity_unique').on(
      table.workspaceId,
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
    }).notNull(),
  },
  () => [],
);
export const webhookTriggerReplayRecords = appSchema.table(
  'webhook_trigger_replay_records',
  {
    workspaceId: uuid('workspace_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    dedupeKind: varchar('dedupe_kind', { length: 16 }).notNull(),
    dedupeKeyHash: varchar('dedupe_key_hash', { length: 64 }).notNull(),
    requestFingerprint: varchar('request_fingerprint', {
      length: 64,
    }).notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.endpointId, table.dedupeKind, table.dedupeKeyHash],
    }),
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
    configFingerprint: varchar('config_fingerprint', { length: 82 }).notNull(),
    anchorAt: timestamp('anchor_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    nextFireAt: timestamp('next_fire_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastFireAt: timestamp('last_fire_at', { withTimezone: true, mode: 'date' }),
    status: varchar('status', { length: 16 }).notNull(),
    healthStatus: varchar('health_status', { length: 32 }).notNull(),
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
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    uniqueIndex('trigger_schedules_workspace_identity_unique').on(
      table.workspaceId,
      table.triggerId,
    ),
    index('trigger_schedules_due_idx').on(table.nextFireAt, table.triggerId),
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
    }).notNull(),
  },
  (table) => [
    uniqueIndex('trigger_schedule_occurrences_identity_unique').on(
      table.triggerId,
      table.scheduledAt,
    ),
  ],
);
