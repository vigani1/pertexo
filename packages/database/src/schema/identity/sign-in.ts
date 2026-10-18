import { sql } from 'drizzle-orm';
import {
  check,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, bytea } from '../namespace.js';

export const authSignInAttempts = appSchema.table(
  'auth_sign_in_attempts',
  {
    id: uuid().primaryKey(),
    provider: text().notNull(),
    stateDigest: bytea('state_digest').notNull(),
    browserDigest: bytea('browser_digest').notNull(),
    returnPath: text('return_path').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    unique('auth_sign_in_state_unique').on(table.stateDigest),
    index('auth_sign_in_expiry_idx').on(table.expiresAt, table.id),
    check(
      'auth_sign_in_digest_valid',
      sql`octet_length(state_digest)=32 AND octet_length(browser_digest)=32`,
    ),
    check(
      'auth_sign_in_provider_valid',
      sql`provider ~ '^[a-z][a-z0-9_-]{0,31}$'`,
    ),
    check(
      'auth_sign_in_path_valid',
      sql`length(return_path) between 1 and 128 AND left(return_path,1)='/'`,
    ),
    check('auth_sign_in_expiry_valid', sql`expires_at>created_at`),
  ],
);
