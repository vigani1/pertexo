import {
  char,
  index,
  inet,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { appSchema } from './app-schema.js';

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
