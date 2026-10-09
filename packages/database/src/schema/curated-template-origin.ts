import { foreignKey, jsonb, primaryKey, uuid } from 'drizzle-orm/pg-core';
import type { WorkflowTemplateOrigin } from '@pertexo/templates';
import { appSchema } from './app-schema.js';
import { workflows } from './authoring.js';

export const workflowTemplateOrigins = appSchema.table(
  'workflow_template_origins',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    origin: jsonb('origin').$type<WorkflowTemplateOrigin>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workflowId] }),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);
