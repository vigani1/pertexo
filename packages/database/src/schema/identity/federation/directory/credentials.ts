import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../../namespace.js';
import { users } from '../../../foundation.js';
import { authOrganizations } from '../organizations.js';
export const authProvisioningCredentials = appSchema.table(
  'auth_provisioning_credentials',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    name: text().notNull(),
    secretDigest: char('secret_digest', { length: 64 }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('auth_provisioning_credential_digest_unique').on(
      t.organizationId,
      t.secretDigest,
    ),
    index('auth_provisioning_credential_org_idx').on(t.organizationId, t.id),
    foreignKey({
      name: 'auth_provisioning_credential_org_fk',
      columns: [t.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_provisioning_credential_creator_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    check(
      'auth_provisioning_credential_name_valid',
      sql`length(btrim(name)) between 1 and 128`,
    ),
    check(
      'auth_provisioning_credential_digest_valid',
      sql`secret_digest ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
