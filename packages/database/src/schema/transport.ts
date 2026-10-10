import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  char,
  check,
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

import { appSchema } from './namespace.js';

export const artifacts = appSchema.table(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    purpose: varchar('purpose', { length: 64 }).notNull(),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    mediaType: varchar('media_type', { length: 255 }).notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 })
      .notNull()
      .default(sql`'pending'::character varying`),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    finalizedAt: timestamp('finalized_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    retentionRetryAt: timestamp('retention_retry_at', {
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
  (table): PgTableExtraConfigValue[] => [
    check(
      'artifacts_byte_length_bounded',
      sql`((byte_length >= 0) AND (byte_length <= '5368709120'::bigint))`,
    ),
    check(
      'artifacts_lifecycle_timestamps',
      sql`((((status)::text = 'pending'::text) AND (finalized_at IS NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'available'::text) AND (finalized_at IS NOT NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'deleting'::text) AND (deleted_at IS NULL)) OR (((status)::text = 'deleted'::text) AND (deleted_at IS NOT NULL)))`,
    ),
    // Kit's check serializer splits on semicolons, including inside literals.
    check(
      'artifacts_media_type_format',
      sql`length(media_type::text) >= 3 AND length(media_type::text) <= 255 AND media_type::text ~ ('^[^[:space:]/'::text || chr(59) || ']+/[^\\r\\n]+$'::text) AND media_type::text !~ '[^	 -~-ÿ]'::text`,
    ),
    check(
      'artifacts_purpose_format',
      sql`((purpose)::text ~ '^[a-z][a-z0-9-]{0,63}$'::text)`,
    ),
    check('artifacts_sha256_format', sql`(sha256 ~ '^[0-9a-f]{64}$'::text)`),
    check(
      'artifacts_status_value',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('available'::character varying)::text, ('deleting'::character varying)::text, ('deleted'::character varying)::text]))`,
    ),
    check(
      'artifacts_storage_key_scope',
      sql`((storage_key)::text = ((('workspaces/'::text || (workspace_id)::text) || '/artifacts/'::text) || (id)::text))`,
    ),
    index('artifacts_available_retention_idx')
      .on(table.expiresAt, table.retentionRetryAt, table.id)
      .where(sql`((status)::text = 'available'::text)`),
    index('artifacts_pending_expiry_idx')
      .on(table.workspaceId, table.expiresAt, table.id)
      .where(sql`((status)::text = 'pending'::text)`),
    uniqueIndex('artifacts_storage_key_idx').on(table.storageKey),
    unique('artifacts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    index('artifacts_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.id,
    ),
  ],
);

export const workspaceArtifactCapacity = appSchema.table(
  'workspace_artifact_capacity',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    byteLimit: bigint('byte_limit', { mode: 'number' })
      .notNull()
      .default(sql`1073741824`),
    artifactCountLimit: integer('artifact_count_limit')
      .notNull()
      .default(sql`1000`),
    chargedBytes: bigint('charged_bytes', { mode: 'number' })
      .notNull()
      .default(sql`0`),
    chargedCount: integer('charged_count')
      .notNull()
      .default(sql`0`),
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
  (): PgTableExtraConfigValue[] => [
    check(
      'workspace_artifact_capacity_byte_limit_valid',
      sql`(byte_limit >= 0)`,
    ),
    check(
      'workspace_artifact_capacity_charged_bytes_valid',
      sql`(charged_bytes >= 0)`,
    ),
    check(
      'workspace_artifact_capacity_charged_count_valid',
      sql`(charged_count >= 0)`,
    ),
    check(
      'workspace_artifact_capacity_count_limit_valid',
      sql`(artifact_count_limit >= 0)`,
    ),
  ],
);
export const outboxEvents = appSchema.table(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    jobName: varchar('job_name', { length: 128 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    payloadChecksum: char('payload_checksum', { length: 64 }).notNull(),
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
  (table): PgTableExtraConfigValue[] => [
    check(
      'outbox_events_aggregate_type_format',
      sql`((aggregate_type)::text ~ '^[a-z][a-z0-9.-]{0,63}$'::text)`,
    ),
    check('outbox_events_attempts_nonnegative', sql`(publish_attempts >= 0)`),
    check(
      'outbox_events_checksum_format',
      sql`(payload_checksum ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'outbox_events_error_code_format',
      sql`((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check(
      'outbox_events_job_name_format',
      sql`((job_name)::text ~ '^[a-z][a-z0-9-]{0,127}$'::text)`,
    ),
    check(
      'outbox_events_lease_complete',
      sql`(((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))`,
    ),
    check(
      'outbox_events_lease_owner_format',
      sql`((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))`,
    ),
    check(
      'outbox_events_payload_bounded',
      sql`(octet_length((payload)::text) <= 4096)`,
    ),
    check(
      'outbox_events_terminal_state_exclusive',
      sql`(NOT ((published_at IS NOT NULL) AND (failed_at IS NOT NULL)))`,
    ),
    index('outbox_events_dispatch_job_due_idx')
      .on(table.jobName, table.availableAt, table.id)
      .where(sql`((published_at IS NULL) AND (failed_at IS NULL))`),
    index('outbox_events_due_idx')
      .on(table.availableAt, table.id)
      .where(sql`((published_at IS NULL) AND (failed_at IS NULL))`),
    index('outbox_events_expired_lease_idx')
      .on(table.leaseExpiresAt, table.id)
      .where(
        sql`((lease_expires_at IS NOT NULL) AND (published_at IS NULL) AND (failed_at IS NULL))`,
      ),
    index('outbox_events_workspace_idx').on(table.workspaceId, table.id),
  ],
);
export const inboxReceipts = appSchema.table(
  'inbox_receipts',
  {
    consumerName: varchar('consumer_name', { length: 128 }).notNull(),
    messageId: uuid('message_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    payloadChecksum: char('payload_checksum', { length: 64 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'inbox_receipts_checksum_format',
      sql`(payload_checksum ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'inbox_receipts_completion_order',
      sql`((completed_at IS NULL) OR (completed_at >= received_at))`,
    ),
    check(
      'inbox_receipts_consumer_name_format',
      sql`((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)`,
    ),
    primaryKey({
      name: 'inbox_receipts_pkey',
      columns: [table.consumerName, table.messageId],
    }),
    index('inbox_receipts_workspace_idx').on(
      table.workspaceId,
      table.receivedAt.desc().nullsFirst(),
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
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'transport_security_audit_consumer_name_format',
      sql`((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)`,
    ),
    check(
      'transport_security_audit_fact_type',
      sql`((fact_type)::text = 'inbox_checksum_mismatch'::text)`,
    ),
    index('transport_audit_retention_dry_run_idx').on(
      table.workspaceId,
      table.occurredAt,
      table.id,
    ),
    index('transport_security_audit_facts_message_idx').on(
      table.workspaceId,
      table.messageId,
    ),
    index('transport_security_audit_facts_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt.desc().nullsFirst(),
    ),
  ],
);

export const outboxFairDispatchCursor = appSchema.table(
  'outbox_fair_dispatch_cursor',
  {
    singleton: boolean().default(true).primaryKey().notNull(),
    lastWorkspaceId: uuid('last_workspace_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (): PgTableExtraConfigValue[] => [
    check('outbox_fair_dispatch_cursor_singleton_check', sql`singleton`),
  ],
);
