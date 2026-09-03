import {
  foreignKey,
  index,
  jsonb,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { previewRuns } from './execution.js';
import { artifacts } from './transport.js';

export const artifactLinks = appSchema.table(
  'artifact_links',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    ownerKind: varchar('owner_kind', { length: 32 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.artifactId,
        table.ownerKind,
        table.ownerId,
      ],
      name: 'artifact_links_identity_unique',
    }),
    foreignKey({
      columns: [table.workspaceId, table.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
      name: 'artifact_links_artifact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
      name: 'artifact_links_preview_run_fk',
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
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
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
  (table) => [
    uniqueIndex('idempotency_records_active_key_unique').on(
      table.workspaceId,
      table.operation,
      table.scope,
      table.keyHash,
    ),
    index('idempotency_records_expiry_idx').on(table.expiresAt, table.id),
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
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    resourceId: uuid('resource_id'),
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
  (table) => [
    uniqueIndex('workspace_creation_idempotency_active_key_unique').on(
      table.actorUserId,
      table.operation,
      table.keyHash,
    ),
    index('workspace_creation_idempotency_expiry_idx').on(
      table.expiresAt,
      table.id,
    ),
  ],
);
