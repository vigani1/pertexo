import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, bytea } from '../../namespace.js';
import { authDomains } from './domains.js';
import { authProviders } from './providers.js';

export const authFederationAttempts = appSchema.table(
  'auth_federation_attempts',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    providerId: uuid('provider_id').notNull(),
    providerRevision: integer('provider_revision').notNull(),
    domainId: uuid('domain_id').notNull(),
    purpose: text().$type<'sign_in' | 'test'>().notNull(),
    ownerUserId: uuid('owner_user_id'),
    ownerSessionId: uuid('owner_session_id'),
    stateDigest: bytea('state_digest').notNull(),
    browserDigest: bytea('browser_digest').notNull(),
    returnPath: text('return_path').notNull(),
    requestId: text('request_id'),
    requestCreatedAt: timestamp('request_created_at', {
      withTimezone: true,
      mode: 'date',
    }),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    foreignKey({
      name: 'auth_federation_attempt_provider_fk',
      columns: [table.organizationId, table.providerId],
      foreignColumns: [authProviders.organizationId, authProviders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_federation_attempt_domain_fk',
      columns: [table.organizationId, table.domainId],
      foreignColumns: [authDomains.organizationId, authDomains.id],
    }).onDelete('cascade'),
    index('auth_federation_attempt_provider_idx').on(
      table.organizationId,
      table.providerId,
    ),
    index('auth_federation_attempt_domain_idx').on(
      table.organizationId,
      table.domainId,
    ),
    unique('auth_federation_attempt_state_unique').on(table.stateDigest),
    index('auth_federation_attempt_expiry_idx').on(table.expiresAt, table.id),
    check(
      'auth_federation_attempt_digest_valid',
      sql`octet_length(state_digest)=32 AND octet_length(browser_digest)=32`,
    ),
    check(
      'auth_federation_attempt_revision_positive',
      sql`provider_revision>0`,
    ),
    check(
      'auth_federation_attempt_purpose_valid',
      sql`(purpose='sign_in' AND owner_user_id is null AND owner_session_id is null) OR (purpose='test' AND owner_user_id is not null AND owner_session_id is not null)`,
    ),
    check(
      'auth_federation_attempt_path_valid',
      sql`length(return_path) between 1 and 256 AND left(return_path,1)='/'`,
    ),
    check('auth_federation_attempt_expiry_valid', sql`expires_at>created_at`),
  ],
);
