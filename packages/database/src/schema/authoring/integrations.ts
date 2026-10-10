import {
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
