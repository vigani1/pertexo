import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../app-schema.js';
import { connections } from '../connections.js';
import { workflowVersions } from './workflows.js';

export const workflowIntegrationUsage = appSchema.table(
  'workflow_integration_usage',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    operationKey: varchar('operation_key', { length: 128 }).notNull(),
    connectionId: uuid('connection_id').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_integration_usage_operation_key_format',
      sql`((operation_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)`,
    ),
    check(
      'workflow_integration_usage_provider_key_format',
      sql`((provider_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)`,
    ),
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
      name: 'workflow_integration_usage_connection_fk',
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_integration_usage_version_fk',
      columns: [table.workspaceId, table.workflowVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
    }).onDelete('cascade'),
    index('workflow_integration_usage_connection_idx').on(
      table.workspaceId,
      table.connectionId,
      table.workflowVersionId,
      table.providerKey,
      table.operationKey,
    ),
    index('workflow_integration_usage_impact_idx').on(
      table.workspaceId,
      table.providerKey,
      table.operationKey,
      table.workflowVersionId,
      table.connectionId,
    ),
  ],
);
