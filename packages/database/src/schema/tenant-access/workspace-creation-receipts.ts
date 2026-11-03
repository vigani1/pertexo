import { users } from '../identity/users.js';
import { workspaces } from './workspaces.js';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const workspaceCreationIdempotencyRecords = appSchema.table(
  'workspace_creation_idempotency_records',
  {
    id: uuid('id').primaryKey(),
    actorUserId: uuid('actor_user_id').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    resourceId: uuid('resource_id'),
    resultRef: jsonb('result_ref')
      .notNull()
      .default(sql`'{}'::jsonb`),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp() + interval '24 hours'`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_creation_idempotency_completed_result',
      sql`(((status)::text <> 'completed'::text) OR ((resource_id IS NOT NULL) AND (result_ref <> '{}'::jsonb)))`,
    ),
    check(
      'workspace_creation_idempotency_expiry_valid',
      sql`(expires_at > created_at)`,
    ),
    check(
      'workspace_creation_idempotency_key_hash_format',
      sql`(key_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'workspace_creation_idempotency_operation_format',
      sql`((operation)::text ~ '^[a-z][a-z0-9.]{0,63}$'::text)`,
    ),
    check(
      'workspace_creation_idempotency_request_hash_format',
      sql`(request_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'workspace_creation_idempotency_result_ref_bounded',
      sql`(octet_length((result_ref)::text) <= 4096)`,
    ),
    check(
      'workspace_creation_idempotency_status_valid',
      sql`((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text]))`,
    ),
    unique('workspace_creation_idempotency_active_key_unique').on(
      table.actorUserId,
      table.operation,
      table.keyHash,
    ),
    foreignKey({
      name: 'workspace_creation_idempotency_records_actor_user_id_fkey',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: 'workspace_creation_idempotency_records_resource_id_fkey',
      columns: [table.resourceId],
      foreignColumns: [workspaces.id],
    }),
    index('workspace_creation_idempotency_expiry_idx').on(
      table.expiresAt,
      table.id,
    ),
  ],
);
