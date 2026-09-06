import {
  bigint,
  index,
  integer,
  jsonb,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';

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

export const workspaceArtifactCapacity = appSchema.table(
  'workspace_artifact_capacity',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    byteLimit: bigint('byte_limit', { mode: 'number' }).notNull(),
    artifactCountLimit: integer('artifact_count_limit').notNull(),
    chargedBytes: bigint('charged_bytes', { mode: 'number' }).notNull(),
    chargedCount: integer('charged_count').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  () => [],
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
