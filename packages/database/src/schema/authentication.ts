import {
  type PgTableExtraConfigValue,
  char,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { authProviders } from './identity/federation/providers.js';

import { appSchema, bytea } from './namespace.js';
import { users } from './foundation.js';

export const authAccounts = appSchema.table(
  'auth_accounts',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('auth_accounts_provider_identity_unique').on(
      table.providerId,
      table.accountId,
    ),
    foreignKey({
      name: 'auth_accounts_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('auth_accounts_user_idx').on(table.userId, table.id),
  ],
);
export const authTwoFactors = appSchema.table('auth_two_factors', {
  id: uuid().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  secret: text().notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean().default(false).notNull(),
  failedVerificationCount: integer('failed_verification_count')
    .default(0)
    .notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .default(sql`clock_timestamp()`)
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .default(sql`clock_timestamp()`)
    .notNull(),
});
export const authSessions = appSchema.table(
  'auth_sessions',
  {
    id: uuid('id').primaryKey(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id').notNull(),
    authenticationMethod: text('authentication_method')
      .$type<'credential' | 'social' | 'organization'>()
      .notNull()
      .default('credential'),
    federationProviderId: uuid('federation_provider_id'),
    federationProviderRevision: integer('federation_provider_revision'),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'auth_session_federation_provider_fk',
      columns: [table.federationProviderId],
      foreignColumns: [authProviders.id],
    }).onDelete('cascade'),
    check(
      'auth_session_authentication_proof_valid',
      sql`(authentication_method in ('credential','social') AND federation_provider_id is null AND federation_provider_revision is null) OR (authentication_method='organization' AND federation_provider_id is not null AND federation_provider_revision is not null AND federation_provider_revision>0)`,
    ),
    check(
      'auth_sessions_expiry_after_creation',
      sql`(expires_at > created_at)`,
    ),
    unique('auth_sessions_token_key').on(table.token),
    foreignKey({
      name: 'auth_sessions_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('auth_sessions_federation_provider_idx').on(
      table.federationProviderId,
      table.id,
    ),
    index('auth_sessions_expiry_idx').on(table.expiresAt, table.id),
    index('auth_sessions_user_expiry_idx').on(
      table.userId,
      table.expiresAt,
      table.id,
    ),
  ],
);
export const authVerifications = appSchema.table(
  'auth_verifications',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index('auth_verifications_expiry_idx').on(table.expiresAt, table.id),
    index('auth_verifications_identifier_idx').on(table.identifier, table.id),
  ],
);
export const userProfileCommandReceipts = appSchema.table(
  'user_profile_command_receipts',
  {
    id: uuid().primaryKey().notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar({ length: 32 }).notNull(),
    resultRef: jsonb('result_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'user_profile_command_receipts_hashes_valid',
      sql`((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'user_profile_command_receipts_result_valid',
      sql`((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))`,
    ),
    check(
      'user_profile_command_receipts_status_valid',
      sql`((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text]))`,
    ),
    foreignKey({
      name: 'user_profile_command_receipts_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('user_profile_command_receipts_key_unique').on(
      table.actorUserId,
      table.keyHash,
    ),
  ],
);

export const authMethodLinkAttempts = appSchema.table(
  'auth_method_link_attempts',
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    browserDigest: bytea('browser_digest').notNull(),
    sourceProvider: varchar('source_provider', { length: 32 }).notNull(),
    targetProvider: varchar('target_provider', { length: 32 })
      .$type<'google' | 'github' | 'microsoft' | 'apple'>()
      .notNull(),
    phase: varchar({ length: 16 }).notNull(),
    stateDigest: bytea('state_digest'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'auth_method_link_browser_digest_valid',
      sql`(octet_length(browser_digest) = 32)`,
    ),
    check(
      'auth_method_link_completion_valid',
      sql`(((phase)::text = 'completed'::text) = (completed_at IS NOT NULL))`,
    ),
    check('auth_method_link_expiry_valid', sql`(expires_at > created_at)`),
    check(
      'auth_method_link_phase_valid',
      sql`((phase)::text = ANY (ARRAY[('source'::character varying)::text, ('target'::character varying)::text, ('completed'::character varying)::text, ('abandoned'::character varying)::text]))`,
    ),
    check(
      'auth_method_link_provider_valid',
      sql`(((source_provider)::text = ANY (ARRAY[('credential'::character varying)::text, ('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])) AND ((target_provider)::text = ANY (ARRAY[('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])) AND ((source_provider)::text <> (target_provider)::text))`,
    ),
    check(
      'auth_method_link_state_digest_valid',
      sql`((state_digest IS NULL) OR (octet_length(state_digest) = 32))`,
    ),
    unique('auth_method_link_attempts_state_digest_key').on(table.stateDigest),
    foreignKey({
      name: 'auth_method_link_attempts_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('auth_method_link_attempts_retention_idx').on(
      table.expiresAt,
      table.id,
    ),
    index('auth_method_link_attempts_user_idx').on(
      table.userId,
      table.sessionId,
      table.createdAt,
    ),
  ],
);

export const authEmailProofs = appSchema.table(
  'auth_email_proofs',
  {
    id: uuid().primaryKey().notNull(),
    tokenDigest: bytea('token_digest').notNull(),
    userId: uuid('user_id').notNull(),
    purpose: varchar({ length: 32 }).notNull(),
    email: varchar({ length: 320 }).notNull(),
    newEmail: varchar('new_email', { length: 320 }),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'auth_email_proof_digest_valid',
      sql`(octet_length(token_digest) = 32)`,
    ),
    check('auth_email_proof_expiry_valid', sql`(expires_at > created_at)`),
    check(
      'auth_email_proof_new_email_valid',
      sql`((((purpose)::text = 'initial_verification'::text) AND (new_email IS NULL)) OR (((purpose)::text = ANY (ARRAY[('change_old'::character varying)::text, ('change_new'::character varying)::text])) AND (new_email IS NOT NULL)))`,
    ),
    check(
      'auth_email_proof_purpose_valid',
      sql`((purpose)::text = ANY (ARRAY[('initial_verification'::character varying)::text, ('change_old'::character varying)::text, ('change_new'::character varying)::text]))`,
    ),
    unique('auth_email_proofs_token_digest_key').on(table.tokenDigest),
    foreignKey({
      name: 'auth_email_proofs_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('auth_email_proofs_retention_idx').on(table.expiresAt, table.id),
    index('auth_email_proofs_user_idx').on(
      table.userId,
      table.purpose,
      table.createdAt,
    ),
  ],
);

export const identitySecurityAuditFacts = appSchema.table(
  'identity_security_audit_facts',
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'identity_security_audit_event_valid',
      sql`((event_type)::text = ANY (ARRAY['email.initial_verified'::text, 'email.old_confirmed'::text, 'email.change_verified'::text, 'method.linked'::text, 'method.unlinked'::text, 'password.changed'::text, 'password.configured'::text, 'password.reset'::text, 'profile.display_name_changed'::text, 'session.signed_in'::text, 'two_factor.disabled'::text, 'two_factor.recovery_code_used'::text, 'two_factor.operator_disabled'::text]))`,
    ),
    index('identity_security_audit_retention_idx').on(
      table.occurredAt,
      table.id,
    ),
    index('identity_security_audit_user_idx').on(
      table.userId,
      table.occurredAt,
    ),
  ],
);
