import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';
import { workspaces } from '../foundation.js';

export const workflowManualStartRejections = appSchema.table(
  'workflow_manual_start_rejections',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    scope: varchar('scope', { length: 128 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    expectedVersionId: uuid('expected_version_id').notNull(),
    observedVersionId: uuid('observed_version_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()+interval '24 hours'`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_manual_start_rejections_check',
      sql`((scope)::text = (('workflow:'::text || (workflow_id)::text) || ':manual'::text))`,
    ),
    check(
      'workflow_manual_start_rejections_check1',
      sql`(expected_version_id <> observed_version_id)`,
    ),
    check(
      'workflow_manual_start_rejections_key_hash_check',
      sql`(key_hash ~ '^[a-f0-9]{64}$'::text)`,
    ),
    check(
      'workflow_manual_start_rejections_request_hash_check',
      sql`(request_hash ~ '^[a-f0-9]{64}$'::text)`,
    ),
    primaryKey({
      name: 'workflow_manual_start_rejections_pkey',
      columns: [table.workspaceId, table.scope, table.keyHash],
    }),
    foreignKey({
      name: 'workflow_manual_start_rejections_workspace_id_fkey',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }),
    foreignKey({
      name: 'workflow_manual_start_rejections_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    index('workflow_manual_start_rejections_expiry_idx').on(
      table.expiresAt,
      table.workspaceId,
      table.scope,
      table.keyHash,
    ),
  ],
);
