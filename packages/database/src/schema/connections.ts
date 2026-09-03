import {
  foreignKey,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';

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
