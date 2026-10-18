import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../../namespace.js';
import { authOrganizations } from '../organizations.js';
export const authDirectoryGroups = appSchema.table(
  'auth_directory_groups',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    displayName: text('display_name').notNull(),
    externalId: text('external_id'),
    revision: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique('auth_directory_group_org_identity_unique').on(
      t.organizationId,
      t.id,
    ),
    uniqueIndex('auth_directory_group_external_unique')
      .on(t.organizationId, t.externalId)
      .where(sql`external_id is not null`),
    foreignKey({
      name: 'auth_directory_group_org_fk',
      columns: [t.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete('cascade'),
    check(
      'auth_directory_group_name_valid',
      sql`length(btrim(display_name)) between 1 and 256`,
    ),
    check(
      'auth_directory_group_external_valid',
      sql`external_id is null or length(external_id) between 1 and 512`,
    ),
    check('auth_directory_group_revision_positive', sql`revision>0`),
  ],
);
