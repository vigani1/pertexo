import {
  EMAIL_ADDRESS_LIMITS,
  DISPLAY_NAME_MAX_CHARACTERS,
} from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';

const WIDTHS = Object.freeze({
  email: EMAIL_ADDRESS_LIMITS.storedAddressCharacters,
  displayName: DISPLAY_NAME_MAX_CHARACTERS,
  status: 32,
});

export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: WIDTHS.email }).notNull(),
    displayName: varchar('display_name', {
      length: WIDTHS.displayName,
    }).notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    twoFactorEnabled: boolean('two_factor_enabled').default(false).notNull(),
    image: text('image'),
    status: varchar('status', { length: WIDTHS.status })
      .$type<'active' | 'suspended' | 'deleted'>()
      .notNull()
      .default(sql`'active'::character varying`),
    profileRevision: integer('profile_revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (): PgTableExtraConfigValue[] => [
    check(
      'users_email_format',
      sql`(((email)::text = btrim((email)::text)) AND ((length((email)::text) >= 3) AND (length((email)::text) <= 320)))`,
    ),
    check('users_profile_revision_positive', sql`(profile_revision > 0)`),
    check(
      'users_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('deleted'::character varying)::text]))`,
    ),
    uniqueIndex('users_email_lower_unique').on(sql`lower((email)::text)`),
    index('users_email_canonical_idx').on(
      sql`lower(normalize((email)::text,NFKC))`,
    ),
  ],
);
