import type { WebhookAuthentication } from '@pertexo/contracts';
import { users } from '../foundation.js';
import { workflows, workflowTriggers } from '../authoring/workflows.js';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const webhookTriggerSecretVersions = appSchema.table(
  'webhook_trigger_secret_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    // The published trigger row this secret was sealed under. Its encryption
    // context names this id, so it stays fixed while the endpoint moves on.
    triggerId: uuid('trigger_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    purpose: varchar('purpose', { length: 32 })
      .notNull()
      .default(sql`'webhook_hmac_sha256'::character varying`),
    kmsKeyReference: varchar('kms_key_reference', { length: 2048 }).notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_trigger_secret_versions_purpose_valid',
      sql`((purpose)::text = 'webhook_hmac_sha256'::text)`,
    ),
    unique('webhook_trigger_secret_versions_step_identity_unique').on(
      table.workspaceId,
      table.workflowId,
      table.nodeId,
      table.id,
    ),
    foreignKey({
      name: 'webhook_trigger_secret_versions_creator_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_secret_versions_trigger_fk',
      columns: [
        table.workspaceId,
        table.triggerId,
        table.workflowId,
        table.nodeId,
      ],
      foreignColumns: [
        workflowTriggers.workspaceId,
        workflowTriggers.id,
        workflowTriggers.workflowId,
        workflowTriggers.nodeId,
      ],
    }).onDelete('restrict'),
  ],
);

// An endpoint belongs to a workflow and its trigger step, not to a version: it
// serves whichever published version contains that step, so a publish moves it
// without touching this row.
export const webhookTriggerEndpoints = appSchema.table(
  'webhook_trigger_endpoints',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    endpointKeyHash: char('endpoint_key_hash', { length: 64 }).notNull(),
    authentication: jsonb('authentication')
      .$type<WebhookAuthentication>()
      .notNull()
      .default(sql`'{"mode":"signed","allowedOrigins":[]}'::jsonb`),
    status: varchar('status', { length: 16 })
      .notNull()
      .default(sql`'active'::character varying`),
    currentSecretVersionId: uuid('current_secret_version_id').notNull(),
    previousSecretVersionId: uuid('previous_secret_version_id'),
    previousSecretValidUntil: timestamp('previous_secret_valid_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_trigger_endpoints_hash_valid',
      sql`(endpoint_key_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'webhook_trigger_endpoints_rotation_valid',
      sql`(((previous_secret_version_id IS NULL) AND (previous_secret_valid_until IS NULL)) OR ((previous_secret_version_id IS NOT NULL) AND (previous_secret_valid_until IS NOT NULL) AND (previous_secret_version_id <> current_secret_version_id)))`,
    ),
    check(
      'webhook_trigger_endpoints_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    unique('webhook_trigger_endpoints_endpoint_key_hash_key').on(
      table.endpointKeyHash,
    ),
    unique('webhook_trigger_endpoints_step_unique').on(
      table.workspaceId,
      table.workflowId,
      table.nodeId,
    ),
    unique('webhook_trigger_endpoints_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'webhook_trigger_endpoints_current_secret_fk',
      columns: [
        table.workspaceId,
        table.workflowId,
        table.nodeId,
        table.currentSecretVersionId,
      ],
      foreignColumns: [
        webhookTriggerSecretVersions.workspaceId,
        webhookTriggerSecretVersions.workflowId,
        webhookTriggerSecretVersions.nodeId,
        webhookTriggerSecretVersions.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_endpoints_previous_secret_fk',
      columns: [
        table.workspaceId,
        table.workflowId,
        table.nodeId,
        table.previousSecretVersionId,
      ],
      foreignColumns: [
        webhookTriggerSecretVersions.workspaceId,
        webhookTriggerSecretVersions.workflowId,
        webhookTriggerSecretVersions.nodeId,
        webhookTriggerSecretVersions.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_endpoints_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
  ],
);
