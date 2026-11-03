import {
  type PgTableExtraConfigValue,
  char,
  check,
  index,
  jsonb,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const idempotencyRecords = appSchema.table(
  'idempotency_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    scope: varchar('scope', { length: 128 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    resultRef: jsonb('result_ref').notNull(),
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
      'idempotency_records_expiry_valid',
      sql`((expires_at IS NULL) OR (expires_at > created_at))`,
    ),
    check(
      'idempotency_records_key_hash_format',
      sql`(key_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'idempotency_records_operation_format',
      sql`((operation)::text ~ '^[a-z][a-z0-9.]{0,63}$'::text)`,
    ),
    check(
      'idempotency_records_request_hash_format',
      sql`(request_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'idempotency_records_result_ref_bounded',
      sql`(octet_length((result_ref)::text) <= 4096)`,
    ),
    check(
      'idempotency_records_scope_format',
      sql`((scope)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)`,
    ),
    check(
      'idempotency_records_status_valid',
      sql`((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text]))`,
    ),
    unique('idempotency_records_active_key_unique').on(
      table.workspaceId,
      table.operation,
      table.scope,
      table.keyHash,
    ),
    index('idempotency_records_expiry_idx')
      .on(table.expiresAt, table.id)
      .where(sql`(expires_at IS NOT NULL)`),
    index('idempotency_records_resource_idx').on(
      table.workspaceId,
      table.resourceId,
    ),
  ],
);
