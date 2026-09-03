import {
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { connections } from './connections.js';

export const workflows = appSchema.table(
  'workflows',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    lifecycleStatus: varchar('lifecycle_status', { length: 32 })
      .default('active')
      .notNull(),
    activationStatus: varchar('activation_status', { length: 32 })
      .default('inactive')
      .notNull(),
    publishedVersionId: uuid('published_version_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`date_trunc('milliseconds', clock_timestamp())`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('workflows_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    index('workflows_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    index('workflows_workspace_name_idx').on(
      table.workspaceId,
      table.name,
      table.id,
    ),
  ],
);
export const workflowDrafts = appSchema.table(
  'workflow_drafts',
  {
    workflowId: uuid('workflow_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
      name: 'workflow_drafts_workflow_workspace_fk',
    }).onDelete('cascade'),
    index('workflow_drafts_workspace_idx').on(
      table.workspaceId,
      table.workflowId,
    ),
  ],
);
export const workflowVersions = appSchema.table(
  'workflow_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    checksum: varchar('checksum', { length: 77 }).notNull(),
    executableSchemaVersion: integer('executable_schema_version'),
    executableJson: jsonb('executable_json'),
    compatibilityReleaseEpoch: integer('compatibility_release_epoch'),
    publishedBy: uuid('published_by').notNull(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('workflow_versions_workspace_identity_unique').on(
      table.workspaceId,
      table.workflowId,
      table.id,
    ),
    uniqueIndex('workflow_versions_number_unique').on(
      table.workflowId,
      table.versionNumber,
    ),
    uniqueIndex('workflow_versions_checksum_unique').on(
      table.workflowId,
      table.checksum,
    ),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
      name: 'workflow_versions_workflow_workspace_fk',
    }),
    index('workflow_versions_workspace_workflow_idx').on(
      table.workspaceId,
      table.workflowId,
      table.versionNumber.desc(),
    ),
  ],
);
export const workflowIntegrationUsage = appSchema.table(
  'workflow_integration_usage',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    operationKey: varchar('operation_key', { length: 128 }).notNull(),
    connectionId: uuid('connection_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'workflow_integration_usage_identity_pk',
      columns: [
        table.workflowVersionId,
        table.providerKey,
        table.operationKey,
        table.connectionId,
      ],
    }),
    foreignKey({
      columns: [table.workspaceId, table.workflowVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
      name: 'workflow_integration_usage_version_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
      name: 'workflow_integration_usage_connection_fk',
    }).onDelete('restrict'),
    index('workflow_integration_usage_impact_idx').on(
      table.workspaceId,
      table.providerKey,
      table.operationKey,
      table.workflowVersionId,
      table.connectionId,
    ),
    index('workflow_integration_usage_connection_idx').on(
      table.workspaceId,
      table.connectionId,
      table.workflowVersionId,
      table.providerKey,
      table.operationKey,
    ),
  ],
);
export const workflowTriggers = appSchema.table(
  'workflow_triggers',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    desiredConfig: jsonb('desired_config').notNull(),
    configFingerprint: varchar('config_fingerprint', { length: 82 }).notNull(),
    healthStatus: varchar('health_status', { length: 32 }).notNull(),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    reconciledAt: timestamp('reconciled_at', {
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
  (table) => [
    uniqueIndex('workflow_triggers_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex('workflow_triggers_version_node_unique').on(
      table.workflowVersionId,
      table.nodeId,
    ),
    index('workflow_triggers_workflow_version_idx').on(
      table.workspaceId,
      table.workflowId,
      table.workflowVersionId,
      table.nodeId,
    ),
  ],
);
