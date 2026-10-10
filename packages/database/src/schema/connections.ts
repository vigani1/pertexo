import { users, workspaces } from './foundation.js';
import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { nodeAttempts } from './runs/execution.js';

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
      .default(sql`1`),
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
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'connections_auth_type_valid',
      sql`((auth_type)::text = ANY (ARRAY[('http_headers'::character varying)::text, ('slack_bot_token'::character varying)::text, ('resend_api_key'::character varying)::text]))`,
    ),
    check(
      'connections_error_code_format',
      sql`((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check('connections_health_revision_positive', sql`(health_revision > 0)`),
    check(
      'connections_health_transition_source_valid',
      sql`((((last_health_transition_at IS NULL) AND (last_health_transition_source IS NULL)) OR ((last_health_transition_at IS NOT NULL) AND ((last_health_transition_source)::text = ANY (ARRAY[('run'::character varying)::text, ('test'::character varying)::text, ('rotation'::character varying)::text, ('revoke'::character varying)::text])))) IS TRUE)`,
    ),
    check(
      'connections_name_bounded',
      sql`(((name)::text = btrim((name)::text)) AND ((length((name)::text) >= 1) AND (length((name)::text) <= 128)))`,
    ),
    check(
      'connections_provider_key_format',
      sql`((provider_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)`,
    ),
    check(
      'connections_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('reauthorization_required'::character varying)::text, ('revoked'::character varying)::text]))`,
    ),
    unique('connections_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'connections_created_by_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    // The baseline sets this foreign key DEFERRABLE INITIALLY DEFERRED.
    foreignKey({
      name: 'connections_current_secret_same_connection_fk',
      columns: [table.workspaceId, table.id, table.currentSecretVersionId],
      foreignColumns: [
        connectionSecretVersions.workspaceId,
        connectionSecretVersions.connectionId,
        connectionSecretVersions.id,
      ],
    }),
    foreignKey({
      name: 'connections_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    uniqueIndex('connections_active_name_provider_unique')
      .on(table.workspaceId, table.providerKey, sql`lower((name)::text)`)
      .where(sql`((status)::text <> 'revoked'::text)`),
    index('connections_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt.desc().nullsFirst(),
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
      'connection_secret_versions_ciphertext_bounded',
      sql`((length(ciphertext) >= 1) AND (length(ciphertext) <= 87382) AND (ciphertext ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    check(
      'connection_secret_versions_encrypted_key_bounded',
      sql`((length(encrypted_data_key) >= 1) AND (length(encrypted_data_key) <= 10923) AND (encrypted_data_key ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    check(
      'connection_secret_versions_kms_reference_bounded',
      sql`((length((kms_key_reference)::text) >= 1) AND (length((kms_key_reference)::text) <= 2048))`,
    ),
    check(
      'connection_secret_versions_nonce_valid',
      sql`((length((nonce)::text) = 16) AND ((nonce)::text ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    check(
      'connection_secret_versions_tag_valid',
      sql`((length((auth_tag)::text) = 22) AND ((auth_tag)::text ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    unique(
      'connection_secret_versions_workspace_connection_identity_unique',
    ).on(table.workspaceId, table.connectionId, table.id),
    foreignKey({
      name: 'connection_secret_versions_connection_fk',
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'connection_secret_versions_created_by_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('connection_secret_versions_connection_created_idx').on(
      table.workspaceId,
      table.connectionId,
      table.createdAt.desc().nullsFirst(),
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
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'connection_events_actor_id_format',
      sql`((actor_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text)`,
    ),
    check(
      'connection_events_actor_kind_valid',
      sql`((actor_kind)::text = ANY (ARRAY[('user'::character varying)::text, ('worker'::character varying)::text, ('system'::character varying)::text]))`,
    ),
    check(
      'connection_events_metadata_bounded',
      sql`(octet_length((metadata)::text) <= 4096)`,
    ),
    check(
      'connection_events_request_id_bounded',
      sql`((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))`,
    ),
    check(
      'connection_events_trace_id_bounded',
      sql`((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128)))`,
    ),
    check(
      'connection_events_type_valid',
      sql`((event_type)::text = ANY (ARRAY[('connection.created'::character varying)::text, ('connection.secret_rotated'::character varying)::text, ('connection.test_succeeded'::character varying)::text, ('connection.test_failed'::character varying)::text, ('connection.reauthorization_required'::character varying)::text, ('connection.revoked'::character varying)::text, ('connection.credential_accessed'::character varying)::text, ('connection.health_changed'::character varying)::text]))`,
    ),
    foreignKey({
      name: 'connection_events_connection_fk',
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete('restrict'),
    index('connection_events_connection_time_idx').on(
      table.workspaceId,
      table.connectionId,
      table.createdAt.desc().nullsFirst(),
      table.id,
    ),
    index('connection_events_workspace_time_idx').on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst(),
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
  (table): PgTableExtraConfigValue[] => [
    check(
      'node_attempt_connection_dispatches_auth_type_check',
      sql`((auth_type)::text = 'slack_bot_token'::text)`,
    ),
    check(
      'node_attempt_connection_dispatches_fence_token_check',
      sql`(fence_token > 0)`,
    ),
    check(
      'node_attempt_connection_dispatches_health_revision_check',
      sql`(health_revision > 0)`,
    ),
    check(
      'node_attempt_connection_dispatches_provider_key_check',
      sql`((provider_key)::text = 'slack'::text)`,
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
  (table): PgTableExtraConfigValue[] => [
    check(
      'connection_health_observations_signal_valid',
      sql`((((kind)::text = 'healthy'::text) AND (reason_code IS NULL)) OR (((kind)::text = 'reauthorization_required'::text) AND (reason_code IS NOT NULL) AND ((reason_code)::text = ANY (ARRAY[('connection.slack_account_inactive'::character varying)::text, ('connection.slack_token_expired'::character varying)::text, ('connection.slack_token_revoked'::character varying)::text]))))`,
    ),
    unique('connection_health_observations_attempt_unique').on(
      table.workspaceId,
      table.attemptId,
    ),
    unique('connection_health_observations_outbox_event_id_key').on(
      table.outboxEventId,
    ),
    foreignKey({
      name: 'connection_health_observations_dispatch_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [
        nodeAttemptConnectionDispatches.workspaceId,
        nodeAttemptConnectionDispatches.attemptId,
      ],
    }).onDelete('cascade'),
    index('connection_health_observations_workspace_time_idx').on(
      table.workspaceId,
      table.observedAt,
      table.id,
    ),
  ],
);
