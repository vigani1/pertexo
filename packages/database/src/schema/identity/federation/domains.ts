import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { authOrganizations } from './organizations.js';

export const authDomains = appSchema.table(
  'auth_domains',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    domain: text().notNull(),
    challenge: text(),
    challengeExpiresAt: timestamp('challenge_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    requireSso: boolean('require_sso').notNull().default(false),
    revision: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    foreignKey({
      name: 'auth_domain_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete('cascade'),
    unique('auth_domain_organization_identity_unique').on(
      table.organizationId,
      table.id,
    ),
    unique('auth_domain_organization_name_unique').on(
      table.organizationId,
      table.domain,
    ),
    uniqueIndex('auth_domain_claim_unique')
      .on(table.domain)
      .where(sql`verified_at is not null`),
    check(
      'auth_domain_name_valid',
      sql`length(domain) between 3 and 253 AND domain=lower(domain)`,
    ),
    check('auth_domain_revision_positive', sql`revision>0`),
    check(
      'auth_domain_challenge_valid',
      sql`(challenge is null AND challenge_expires_at is null) OR (challenge is not null AND challenge ~ '^[A-Za-z0-9_-]{43}$' AND challenge_expires_at is not null)`,
    ),
  ],
);
