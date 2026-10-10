import { appSchema } from '../app-schema.js';
import { foreignKey, integer, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { workflows } from './workflows.js';

export const workflowConcurrencyPolicies = appSchema.table(
  'workflow_concurrency_policies',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    activeRunLimit: integer('active_run_limit'),
    revision: integer('revision').notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workflowId] }),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);
