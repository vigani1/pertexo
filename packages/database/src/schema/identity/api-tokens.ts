import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { ApiTokenScope } from '@pertexo/contracts';
import { API_TOKEN_SCOPES } from '@pertexo/contracts';
import { workspaceMemberships } from '../foundation.js';
import { appSchema } from '../namespace.js';

export const apiTokens = appSchema.table(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    secretDigest: char('secret_digest', { length: 64 }).notNull(),
    scopes: jsonb('scopes').$type<readonly ApiTokenScope[]>().notNull(),
    membershipRevision: integer('membership_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    foreignKey({
      name: 'api_tokens_membership_fk',
      columns: [table.workspaceId, table.ownerUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('restrict'),
    check(
      'api_tokens_name_bounded',
      sql`length(btrim(name)) between 1 and 128`,
    ),
    check('api_tokens_digest_valid', sql`secret_digest ~ '^[0-9a-f]{64}$'`),
    check('api_tokens_revision_positive', sql`membership_revision > 0`),
    check(
      'api_tokens_expiry_valid',
      sql`expires_at > created_at and expires_at <= created_at + interval '31536000 seconds'`,
    ),
    check(
      'api_tokens_scopes_valid',
      sql`jsonb_typeof(scopes) = 'array' and jsonb_array_length(scopes) between 1 and 7 and scopes <@ ${sql.raw(`'${serializeStoredExecutionJsonValue(API_TOKEN_SCOPES)}'`)}::jsonb`,
    ),
    index('api_tokens_owner_page_idx').on(
      table.workspaceId,
      table.ownerUserId,
      table.id,
    ),
    index('api_tokens_expiry_idx').on(table.expiresAt, table.id),
    index('api_tokens_revoked_idx')
      .on(table.revokedAt, table.id)
      .where(sql`revoked_at is not null`),
  ],
);
