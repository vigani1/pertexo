import { SHA256_HEX_CHARACTERS } from '../column-widths.js';
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
import { IDEMPOTENCY_KEY_RETENTION_HOURS } from '@pertexo/workflow-model';

const WIDTHS = Object.freeze({
  operation: 64,
  scope: 128,
  keyHash: SHA256_HEX_CHARACTERS,
  requestHash: SHA256_HEX_CHARACTERS,
  status: 16,
});

export const idempotencyRecords = appSchema.table(
  'idempotency_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    operation: varchar('operation', { length: WIDTHS.operation }).notNull(),
    scope: varchar('scope', { length: WIDTHS.scope }).notNull(),
    keyHash: char('key_hash', { length: WIDTHS.keyHash }).notNull(),
    requestHash: char('request_hash', { length: WIDTHS.requestHash }).notNull(),
    status: varchar('status', { length: WIDTHS.status }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    resultRef: jsonb('result_ref').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(
        sql.raw(
          `clock_timestamp() + interval '${String(IDEMPOTENCY_KEY_RETENTION_HOURS)} hours'`,
        ),
      )
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
    // Full sharing receipts include 100 labels, each up to 256 six-byte JSON escapes.
    check(
      'idempotency_records_result_ref_bounded',
      sql`(octet_length((result_ref)::text) <= 196608)`,
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
