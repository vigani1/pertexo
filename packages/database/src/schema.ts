import {
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

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

export const databaseSchema = { inboxReceipts, outboxEvents, rlsProbeRecords };
