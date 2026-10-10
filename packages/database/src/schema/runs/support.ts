import { users, workspaces } from '../foundation.js';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from '../app-schema.js';
import { previewRuns } from './execution.js';
import { artifacts } from '../transport.js';

export const artifactLinks = appSchema.table(
  'artifact_links',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    ownerKind: varchar('owner_kind', { length: 32 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'artifact_links_owner_kind_valid',
      sql`((owner_kind)::text = 'preview_run'::text)`,
    ),
    primaryKey({
      name: 'artifact_links_identity_unique',
      columns: [
        table.workspaceId,
        table.artifactId,
        table.ownerKind,
        table.ownerId,
      ],
    }),
    foreignKey({
      name: 'artifact_links_artifact_fk',
      columns: [table.workspaceId, table.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'artifact_links_preview_run_fk',
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
    }).onDelete('restrict'),
    index('artifact_links_owner_idx').on(
      table.workspaceId,
      table.ownerKind,
      table.ownerId,
      table.artifactId,
    ),
  ],
);
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
