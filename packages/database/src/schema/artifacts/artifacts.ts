import type { ArtifactStatus } from '../stored-shapes.js';
import {
  type PgTableExtraConfigValue,
  bigint,
  char,
  check,
  index,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const artifacts = appSchema.table(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    purpose: varchar('purpose', { length: 64 }).notNull(),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    mediaType: varchar('media_type', { length: 255 }).notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 })
      .$type<ArtifactStatus>()
      .notNull()
      .default(sql`'pending'::character varying`),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    finalizedAt: timestamp('finalized_at', {
      withTimezone: true,
      mode: 'date',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    retentionRetryAt: timestamp('retention_retry_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'artifacts_byte_length_bounded',
      sql`((byte_length >= 0) AND (byte_length <= '5368709120'::bigint))`,
    ),
    check(
      'artifacts_lifecycle_timestamps',
      sql`((((status)::text = 'pending'::text) AND (finalized_at IS NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'available'::text) AND (finalized_at IS NOT NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'deleting'::text) AND (deleted_at IS NULL)) OR (((status)::text = 'deleted'::text) AND (deleted_at IS NOT NULL)))`,
    ),
    // Kit's check serializer splits on semicolons, including inside literals.
    check(
      'artifacts_media_type_format',
      sql`length(media_type::text) >= 3 AND length(media_type::text) <= 255 AND media_type::text ~ ('^[^[:space:]/'::text || chr(59) || ']+/[^\\r\\n]+$'::text) AND media_type::text !~ '[^	 -~-ÿ]'::text`,
    ),
    check(
      'artifacts_purpose_format',
      sql`((purpose)::text ~ '^[a-z][a-z0-9-]{0,63}$'::text)`,
    ),
    check('artifacts_sha256_format', sql`(sha256 ~ '^[0-9a-f]{64}$'::text)`),
    check(
      'artifacts_status_value',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('available'::character varying)::text, ('deleting'::character varying)::text, ('deleted'::character varying)::text]))`,
    ),
    check(
      'artifacts_storage_key_scope',
      sql`((storage_key)::text = ((('workspaces/'::text || (workspace_id)::text) || '/artifacts/'::text) || (id)::text))`,
    ),
    index('artifacts_available_retention_idx')
      .on(table.expiresAt, table.retentionRetryAt, table.id)
      .where(sql`((status)::text = 'available'::text)`),
    index('artifacts_pending_expiry_idx')
      .on(table.workspaceId, table.expiresAt, table.id)
      .where(sql`((status)::text = 'pending'::text)`),
    uniqueIndex('artifacts_storage_key_idx').on(table.storageKey),
    unique('artifacts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    index('artifacts_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.id,
    ),
  ],
);
