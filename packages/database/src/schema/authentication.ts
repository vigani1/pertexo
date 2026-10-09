import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  inet,
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

import { appSchema, bytea } from './app-schema.js';
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
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('auth_accounts_provider_identity_unique').on(
      table.providerId,
      table.accountId,
    ),
    index('auth_accounts_user_idx').on(table.userId, table.id),
  ],
);
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
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_unique').on(table.token),
    index('auth_sessions_user_expiry_idx').on(
      table.userId,
      table.expiresAt,
      table.id,
    ),
    index('auth_sessions_expiry_idx').on(table.expiresAt, table.id),
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
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('auth_verifications_identifier_idx').on(table.identifier, table.id),
    index('auth_verifications_expiry_idx').on(table.expiresAt, table.id),
  ],
);
export const authIdentities = appSchema.table(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    issuer: varchar('issuer', { length: 2048 }).notNull(),
    providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
    nativeMethodVerifiedAt: timestamp('native_method_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    profileMetadata: jsonb('profile_metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('auth_identities_issuer_subject_unique').on(
      table.issuer,
      table.providerSubject,
    ),
    index('auth_identities_user_idx').on(table.userId, table.id),
  ],
);
export const sessions = appSchema.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    userAgent: varchar('user_agent', { length: 512 }),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_digest_unique').on(table.tokenDigest),
    index('sessions_user_active_idx').on(
      table.userId,
      table.expiresAt,
      table.id,
    ),
    index('sessions_expiry_idx').on(table.expiresAt, table.id),
  ],
);
export const oidcLoginTransactions = appSchema.table(
  'oidc_login_transactions',
  {
    stateDigest: varchar('state_digest', { length: 64 }).primaryKey(),
    browserBindingDigest: char('browser_binding_digest', {
      length: 64,
    }).notNull(),
    codeVerifierCiphertext: text('code_verifier_ciphertext').notNull(),
    codeVerifierNonce: varchar('code_verifier_nonce', {
      length: 128,
    }).notNull(),
    codeVerifierTag: varchar('code_verifier_tag', { length: 256 }).notNull(),
    codeVerifierKeyVersion: varchar('code_verifier_key_version', {
      length: 64,
    }).notNull(),
    nonceCiphertext: text('nonce_ciphertext').notNull(),
    nonceNonce: varchar('nonce_nonce', { length: 128 }).notNull(),
    nonceTag: varchar('nonce_tag', { length: 256 }).notNull(),
    nonceKeyVersion: varchar('nonce_key_version', { length: 64 }).notNull(),
    continuationKind: varchar('continuation_kind', { length: 32 }),
    continuationRef: jsonb('continuation_ref'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('oidc_login_transactions_expiry_idx').on(
      table.expiresAt,
      table.stateDigest,
    ),
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
  (table) => [
    check(
      'user_profile_command_receipts_hashes_valid',
      sql`(key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'user_profile_command_receipts_result_valid',
      sql`(((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL))`,
    ),
    check(
      'user_profile_command_receipts_status_valid',
      sql`(status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text])`,
    ),
    uniqueIndex('user_profile_command_receipts_key_unique').on(
      table.actorUserId,
      table.keyHash,
    ),
    foreignKey({
      name: 'user_profile_command_receipts_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

export const authLegacyMethodMigrationAttempts = appSchema.table(
  'auth_legacy_method_migration_attempts',
  {
    id: uuid().primaryKey().notNull(),
    browserDigest: bytea('browser_digest').notNull(),
    oidcStateDigest: bytea('oidc_state_digest').notNull(),
    targetStateDigest: bytea('target_state_digest'),
    targetProvider: varchar('target_provider', { length: 32 }).notNull(),
    legacyIdentityId: uuid('legacy_identity_id'),
    userId: uuid('user_id'),
    phase: varchar({ length: 16 }).default('legacy').notNull(),
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
  (table) => [
    check(
      'auth_legacy_migration_completion_valid',
      sql`((phase)::text = 'completed'::text) = (completed_at IS NOT NULL)`,
    ),
    check(
      'auth_legacy_migration_digest_valid',
      sql`(octet_length(browser_digest) = 32) AND (octet_length(oidc_state_digest) = 32) AND ((target_state_digest IS NULL) OR (octet_length(target_state_digest) = 32))`,
    ),
    check('auth_legacy_migration_expiry_valid', sql`expires_at > created_at`),
    check(
      'auth_legacy_migration_phase_valid',
      sql`(phase)::text = ANY (ARRAY[('legacy'::character varying)::text, ('target'::character varying)::text, ('completed'::character varying)::text, ('abandoned'::character varying)::text])`,
    ),
    check(
      'auth_legacy_migration_proof_valid',
      sql`(((phase)::text = 'legacy'::text) AND (user_id IS NULL) AND (legacy_identity_id IS NULL) AND (target_state_digest IS NULL)) OR (((phase)::text <> 'legacy'::text) AND (user_id IS NOT NULL) AND (legacy_identity_id IS NOT NULL))`,
    ),
    check(
      'auth_legacy_migration_provider_valid',
      sql`(target_provider)::text = ANY (ARRAY[('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])`,
    ),
    unique('auth_legacy_method_migration_attempts_oidc_state_digest_key').on(
      table.oidcStateDigest,
    ),
    unique('auth_legacy_method_migration_attempts_target_state_digest_key').on(
      table.targetStateDigest,
    ),
    index('auth_legacy_method_migration_retention_idx').on(
      table.expiresAt,
      table.id,
    ),
    index('auth_legacy_method_migration_user_idx').on(
      table.userId,
      table.createdAt,
    ),
    foreignKey({
      name: 'auth_legacy_method_migration_attempts_legacy_identity_id_fkey',
      columns: [table.legacyIdentityId],
      foreignColumns: [authIdentities.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'auth_legacy_method_migration_attempts_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
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
    targetProvider: varchar('target_provider', { length: 32 }).notNull(),
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
  (table) => [
    check(
      'auth_method_link_browser_digest_valid',
      sql`octet_length(browser_digest) = 32`,
    ),
    check(
      'auth_method_link_completion_valid',
      sql`((phase)::text = 'completed'::text) = (completed_at IS NOT NULL)`,
    ),
    check('auth_method_link_expiry_valid', sql`expires_at > created_at`),
    check(
      'auth_method_link_phase_valid',
      sql`(phase)::text = ANY (ARRAY[('source'::character varying)::text, ('target'::character varying)::text, ('completed'::character varying)::text, ('abandoned'::character varying)::text])`,
    ),
    check(
      'auth_method_link_provider_valid',
      sql`((source_provider)::text = ANY (ARRAY[('credential'::character varying)::text, ('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])) AND ((target_provider)::text = ANY (ARRAY[('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])) AND ((source_provider)::text <> (target_provider)::text)`,
    ),
    check(
      'auth_method_link_state_digest_valid',
      sql`(state_digest IS NULL) OR (octet_length(state_digest) = 32)`,
    ),
    unique('auth_method_link_attempts_state_digest_key').on(table.stateDigest),
    index('auth_method_link_attempts_retention_idx').on(
      table.expiresAt,
      table.id,
    ),
    index('auth_method_link_attempts_user_idx').on(
      table.userId,
      table.sessionId,
      table.createdAt,
    ),
    foreignKey({
      name: 'auth_method_link_attempts_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
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
  (table) => [
    check(
      'auth_email_proof_digest_valid',
      sql`octet_length(token_digest) = 32`,
    ),
    check('auth_email_proof_expiry_valid', sql`expires_at > created_at`),
    check(
      'auth_email_proof_new_email_valid',
      sql`(((purpose)::text = 'initial_verification'::text) AND (new_email IS NULL)) OR (((purpose)::text = ANY (ARRAY[('change_old'::character varying)::text, ('change_new'::character varying)::text])) AND (new_email IS NOT NULL))`,
    ),
    check(
      'auth_email_proof_purpose_valid',
      sql`(purpose)::text = ANY (ARRAY[('initial_verification'::character varying)::text, ('change_old'::character varying)::text, ('change_new'::character varying)::text])`,
    ),
    unique('auth_email_proofs_token_digest_key').on(table.tokenDigest),
    index('auth_email_proofs_retention_idx').on(table.expiresAt, table.id),
    index('auth_email_proofs_user_idx').on(
      table.userId,
      table.purpose,
      table.createdAt,
    ),
    foreignKey({
      name: 'auth_email_proofs_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

export const authenticationMailDeliveries = appSchema.table(
  'authentication_mail_deliveries',
  {
    id: uuid().primaryKey().notNull(),
    purpose: varchar({ length: 32 }).notNull(),
    status: varchar({ length: 32 }).default('queued').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseGeneration: bigint('lease_generation', { mode: 'number' })
      .default(0)
      .notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    payloadCiphertext: text('payload_ciphertext'),
    payloadNonce: varchar('payload_nonce', { length: 128 }),
    payloadTag: varchar('payload_tag', { length: 256 }),
    payloadKeyVersion: varchar('payload_key_version', { length: 64 }),
    providerReference: varchar('provider_reference', { length: 512 }),
    failureCode: varchar('failure_code', { length: 128 }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    check(
      'authentication_mail_active_has_payload',
      sql`((status)::text <> ALL (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text])) OR (payload_ciphertext IS NOT NULL)`,
    ),
    check(
      'authentication_mail_attempts_bounded',
      sql`(attempt_count >= 0) AND (attempt_count <= 12)`,
    ),
    check(
      'authentication_mail_expiry_after_creation',
      sql`expires_at > created_at`,
    ),
    check(
      'authentication_mail_lease_complete',
      sql`((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL))`,
    ),
    check(
      'authentication_mail_payload_complete',
      sql`((payload_ciphertext IS NULL) AND (payload_nonce IS NULL) AND (payload_tag IS NULL) AND (payload_key_version IS NULL)) OR ((payload_ciphertext IS NOT NULL) AND (payload_nonce IS NOT NULL) AND (payload_tag IS NOT NULL) AND (payload_key_version IS NOT NULL))`,
    ),
    check(
      'authentication_mail_purpose_valid',
      sql`(purpose)::text = ANY (ARRAY[('verification'::character varying)::text, ('password_reset'::character varying)::text, ('email_change_confirmation'::character varying)::text])`,
    ),
    check(
      'authentication_mail_status_valid',
      sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('reconciliation_required'::character varying)::text, ('expired'::character varying)::text])`,
    ),
    index('authentication_mail_due_idx')
      .on(table.nextAttemptAt, table.id)
      .where(
        sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text])`,
      ),
    index('authentication_mail_retention_idx')
      .on(table.completedAt, table.id)
      .where(
        sql`(status)::text = ANY (ARRAY[('submitted'::character varying)::text, ('failed'::character varying)::text, ('reconciliation_required'::character varying)::text, ('expired'::character varying)::text])`,
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
  (table) => [
    check(
      'identity_security_audit_event_valid',
      sql`(event_type)::text = ANY (ARRAY[('email.initial_verified'::character varying)::text, ('email.old_confirmed'::character varying)::text, ('email.change_verified'::character varying)::text, ('method.linked'::character varying)::text, ('method.unlinked'::character varying)::text, ('legacy.method_migrated'::character varying)::text, ('password.changed'::character varying)::text, ('password.configured'::character varying)::text, ('password.reset'::character varying)::text, ('profile.display_name_changed'::character varying)::text])`,
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
