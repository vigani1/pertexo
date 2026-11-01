import { sql } from 'drizzle-orm';
import {
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
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../../namespace.js';
import { users } from '../../../foundation.js';
import { authOrganizations } from '../organizations.js';
import type { DirectoryUserProfile } from '../../../stored-shapes.js';

export const authDirectoryUsers = appSchema.table(
  'auth_directory_users',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    userName: text('user_name').notNull(),
    normalizedUserName: text('normalized_user_name').notNull(),
    loginEmail: text('login_email').notNull(),
    externalId: text('external_id'),
    active: boolean().notNull().default(true),
    profile: jsonb().$type<DirectoryUserProfile>().notNull(),
    userId: uuid('user_id'),
    revision: integer().notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique('auth_directory_user_org_identity_unique').on(
      t.organizationId,
      t.id,
    ),
    unique('auth_directory_user_binding_identity_unique').on(
      t.organizationId,
      t.id,
      t.userId,
    ),
    uniqueIndex('auth_directory_user_live_name_unique')
      .on(t.organizationId, t.normalizedUserName)
      .where(sql`deleted_at is null`),
    uniqueIndex('auth_directory_user_live_email_unique')
      .on(t.organizationId, t.loginEmail)
      .where(sql`deleted_at is null`),
    uniqueIndex('auth_directory_user_live_external_unique')
      .on(t.organizationId, t.externalId)
      .where(sql`deleted_at is null and external_id is not null`),
    uniqueIndex('auth_directory_user_live_binding_unique')
      .on(t.organizationId, t.userId)
      .where(sql`deleted_at is null and user_id is not null`),
    index('auth_directory_user_bound_idx').on(t.userId, t.organizationId),
    index('auth_directory_user_email_idx').on(t.organizationId, t.loginEmail),
    foreignKey({
      name: 'auth_directory_user_org_fk',
      columns: [t.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_directory_user_account_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    check(
      'auth_directory_user_name_valid',
      sql`length(user_name) between 1 and 320 and length(normalized_user_name) between 1 and 320`,
    ),
    check(
      'auth_directory_user_email_valid',
      sql`length(login_email) between 3 and 320`,
    ),
    check(
      'auth_directory_user_external_valid',
      sql`external_id is null or length(external_id) between 1 and 512`,
    ),
    check('auth_directory_user_revision_positive', sql`revision>0`),
    check(
      'auth_directory_user_profile_bounded',
      sql`jsonb_typeof(profile)='object' and octet_length(profile::text)<=16384`,
    ),
    check(
      'auth_directory_user_deleted_inactive',
      sql`deleted_at is null or not active`,
    ),
  ],
);
