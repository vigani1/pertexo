import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import { workspaceMemberships } from './foundation.js';
import { connectionSecretVersions } from './connections.js';
import { appSchema } from './namespace.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** A client's settings never change: new settings are a new secret version. */
export const connectionOAuth2Clients = appSchema.table(
  'connection_oauth2_clients',
  {
    workspaceId: uuid('workspace_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    secretVersionId: uuid('secret_version_id').notNull(),
    settings: jsonb('settings').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'connection_oauth2_clients_pkey',
      columns: [table.workspaceId, table.connectionId, table.secretVersionId],
    }),
    check(
      'connection_oauth2_clients_settings_bounded',
      sql`octet_length(settings::text) <= 16384`,
    ),
    foreignKey({
      name: 'connection_oauth2_clients_secret_version_fk',
      columns: [table.workspaceId, table.connectionId, table.secretVersionId],
      foreignColumns: [
        connectionSecretVersions.workspaceId,
        connectionSecretVersions.connectionId,
        connectionSecretVersions.id,
      ],
    }).onDelete('cascade'),
  ],
);

/** Exists exactly while the connection is connected; `id` is its version. */
export const connectionOAuth2Tokens = appSchema.table(
  'connection_oauth2_tokens',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    secretVersionId: uuid('secret_version_id').notNull(),
    kmsKeyReference: varchar('kms_key_reference', { length: 2048 }).notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    authorizedAt: timestamp('authorized_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    issuedAt: timestamp('issued_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    renewable: boolean('renewable').notNull(),
    refreshBlockedUntil: timestamp('refresh_blocked_until', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('connection_oauth2_tokens_one_per_connection').on(
      table.workspaceId,
      table.connectionId,
    ),
    check(
      'connection_oauth2_tokens_ciphertext_bounded',
      sql`((length(ciphertext) >= 1) AND (length(ciphertext) <= 87382) AND (ciphertext ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    check(
      'connection_oauth2_tokens_encrypted_key_bounded',
      sql`((length(encrypted_data_key) >= 1) AND (length(encrypted_data_key) <= 10923) AND (encrypted_data_key ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    check(
      'connection_oauth2_tokens_kms_reference_bounded',
      sql`((length((kms_key_reference)::text) >= 1) AND (length((kms_key_reference)::text) <= 2048))`,
    ),
    check(
      'connection_oauth2_tokens_nonce_valid',
      sql`((length((nonce)::text) = 16) AND ((nonce)::text ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    check(
      'connection_oauth2_tokens_tag_valid',
      sql`((length((auth_tag)::text) = 22) AND ((auth_tag)::text ~ '^[A-Za-z0-9_-]+$'::text))`,
    ),
    foreignKey({
      name: 'connection_oauth2_tokens_client_fk',
      columns: [table.workspaceId, table.connectionId, table.secretVersionId],
      foreignColumns: [
        connectionOAuth2Clients.workspaceId,
        connectionOAuth2Clients.connectionId,
        connectionOAuth2Clients.secretVersionId,
      ],
    }).onDelete('cascade'),
  ],
);

/** At most one consent per connection is pending, and only its digests are kept. */
export const connectionOAuth2Authorizations = appSchema.table(
  'connection_oauth2_authorizations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    stateDigest: bytea('state_digest').notNull(),
    bindingDigest: bytea('binding_digest').notNull(),
    startedBy: uuid('started_by').notNull(),
    secretVersionId: uuid('secret_version_id').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'connection_oauth2_authorizations_pkey',
      columns: [table.workspaceId, table.connectionId],
    }),
    unique('connection_oauth2_authorizations_state_unique').on(
      table.workspaceId,
      table.stateDigest,
    ),
    check(
      'connection_oauth2_authorizations_state_digest_size',
      sql`octet_length(state_digest) = 32`,
    ),
    check(
      'connection_oauth2_authorizations_binding_digest_size',
      sql`octet_length(binding_digest) = 32`,
    ),
    foreignKey({
      name: 'connection_oauth2_authorizations_client_fk',
      columns: [table.workspaceId, table.connectionId, table.secretVersionId],
      foreignColumns: [
        connectionOAuth2Clients.workspaceId,
        connectionOAuth2Clients.connectionId,
        connectionOAuth2Clients.secretVersionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'connection_oauth2_authorizations_member_fk',
      columns: [table.workspaceId, table.startedBy],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('cascade'),
  ],
);
