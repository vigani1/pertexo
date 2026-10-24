import type { OidcConfiguration, SamlConfiguration } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  index,
  unique,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { authOrganizations } from './organizations.js';
import { authDomains } from './domains.js';

export const authProviders = appSchema.table(
  'auth_providers',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    kind: text().$type<'oidc' | 'saml'>().notNull(),
    name: text().notNull(),
    issuer: text().notNull(),
    configuration: jsonb()
      .$type<OidcConfiguration | SamlConfiguration>()
      .notNull(),
    sealedSecret:
      jsonb('sealed_secret').$type<Readonly<Record<string, unknown>>>(),
    enabled: boolean().notNull().default(false),
    revision: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('auth_provider_organization_identity_unique').on(
      table.organizationId,
      table.id,
    ),
    index('auth_provider_organization_idx').on(table.organizationId),
    foreignKey({
      name: 'auth_provider_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete('cascade'),
    check(
      'auth_provider_secret_presence_valid',
      sql`kind <> 'oidc' OR sealed_secret is not null`,
    ),
    check('auth_provider_kind_valid', sql`kind in ('oidc','saml')`),
    check(
      'auth_provider_name_valid',
      sql`length(btrim(name)) between 1 and 128`,
    ),
    check('auth_provider_issuer_valid', sql`length(issuer) between 1 and 2048`),
    check('auth_provider_revision_positive', sql`revision>0`),
    check(
      'auth_provider_configuration_bounded',
      sql`jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=131072`,
    ),
    check(
      'auth_provider_secret_bounded',
      sql`sealed_secret is null OR (jsonb_typeof(sealed_secret)='object' AND octet_length(sealed_secret::text)<=32768)`,
    ),
  ],
);

export const authProviderChecks = appSchema.table(
  'auth_provider_checks',
  {
    organizationId: uuid('organization_id').notNull(),
    domainId: uuid('domain_id').notNull(),
    providerId: uuid('provider_id').notNull(),
    providerRevision: integer('provider_revision').notNull(),
    testedAt: timestamp('tested_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({
      name: 'auth_provider_checks_pkey',
      columns: [table.organizationId, table.domainId, table.providerId],
    }),
    foreignKey({
      name: 'auth_provider_check_domain_fk',
      columns: [table.organizationId, table.domainId],
      foreignColumns: [authDomains.organizationId, authDomains.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_provider_check_provider_fk',
      columns: [table.organizationId, table.providerId],
      foreignColumns: [authProviders.organizationId, authProviders.id],
    }).onDelete('cascade'),
    index('auth_provider_checks_provider_idx').on(
      table.organizationId,
      table.providerId,
    ),
    check('auth_provider_check_revision_positive', sql`provider_revision>0`),
  ],
);
