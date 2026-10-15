import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  index,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from './workflows.js';

export const workflowErrorPolicies = appSchema.table(
  'workflow_error_policies',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    targetWorkflowId: uuid('target_workflow_id'),
    revision: integer().notNull().default(1),
  },
  (table) => [
    index('workflow_error_policies_target_idx').on(
      table.workspaceId,
      table.targetWorkflowId,
    ),
    primaryKey({ columns: [table.workspaceId, table.workflowId] }),
    check('workflow_error_policies_revision_positive', sql`revision > 0`),
    check(
      'workflow_error_policies_different_target',
      sql`workflow_id <> target_workflow_id`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.targetWorkflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
  ],
);
