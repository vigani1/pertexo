import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { nodeAttempts } from './execution.js';

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
    healthRevision: bigint('health_revision', { mode: 'bigint' })
      .notNull()
      .default(1n),
    lastRunObservedAt: timestamp('last_run_observed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastHealthTransitionAt: timestamp('last_health_transition_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastHealthTransitionSource: varchar('last_health_transition_source', {
      length: 16,
    }),
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

export const nodeAttemptConnectionDispatches = appSchema.table(
  'node_attempt_connection_dispatches',
  {
    workspaceId: uuid('workspace_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    authType: varchar('auth_type', { length: 64 }).notNull(),
    secretVersionId: uuid('secret_version_id').notNull(),
    healthRevision: bigint('health_revision', { mode: 'number' }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    fenceToken: bigint('fence_token', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'node_attempt_connection_dispatches_auth_type_check',
      sql`(auth_type)::text = 'slack_bot_token'::text`,
    ),
    check(
      'node_attempt_connection_dispatches_fence_token_check',
      sql`fence_token > 0`,
    ),
    check(
      'node_attempt_connection_dispatches_health_revision_check',
      sql`health_revision > 0`,
    ),
    check(
      'node_attempt_connection_dispatches_provider_key_check',
      sql`(provider_key)::text = 'slack'::text`,
    ),
    primaryKey({
      name: 'node_attempt_connection_dispatches_pkey',
      columns: [table.workspaceId, table.attemptId],
    }),
    foreignKey({
      name: 'node_attempt_connection_dispatches_attempt_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [nodeAttempts.workspaceId, nodeAttempts.id],
    }).onDelete('cascade'),
  ],
);

export const connectionHealthObservations = appSchema.table(
  'connection_health_observations',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    kind: varchar({ length: 32 }).notNull(),
    reasonCode: varchar('reason_code', { length: 128 }),
    outboxEventId: uuid('outbox_event_id').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'connection_health_observations_signal_valid',
      sql`(((kind)::text = 'healthy'::text) AND (reason_code IS NULL)) OR (((kind)::text = 'reauthorization_required'::text) AND (reason_code IS NOT NULL) AND ((reason_code)::text = ANY (ARRAY[('connection.slack_account_inactive'::character varying)::text, ('connection.slack_token_expired'::character varying)::text, ('connection.slack_token_revoked'::character varying)::text])))`,
    ),
    unique('connection_health_observations_attempt_unique').on(
      table.workspaceId,
      table.attemptId,
    ),
    unique('connection_health_observations_outbox_event_id_key').on(
      table.outboxEventId,
    ),
    index('connection_health_observations_workspace_time_idx').on(
      table.workspaceId,
      table.observedAt,
      table.id,
    ),
    foreignKey({
      name: 'connection_health_observations_dispatch_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [
        nodeAttemptConnectionDispatches.workspaceId,
        nodeAttemptConnectionDispatches.attemptId,
      ],
    }).onDelete('cascade'),
  ],
);
