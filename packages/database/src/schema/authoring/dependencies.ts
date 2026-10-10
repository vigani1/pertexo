import {
  type PgTableExtraConfigValue,
  foreignKey,
  index,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflowVersions } from './workflows.js';

/** A retained publication pins its exact same-workspace child versions. */
export const workflowVersionDependencies = appSchema.table(
  'workflow_version_dependencies',
  {
    workspaceId: uuid('workspace_id').notNull(),
    parentVersionId: uuid('parent_version_id').notNull(),
    nodeId: varchar('node_id', { length: 64 }).notNull(),
    targetWorkflowId: uuid('target_workflow_id').notNull(),
    targetVersionId: uuid('target_version_id').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      columns: [table.workspaceId, table.parentVersionId, table.nodeId],
    }),
    foreignKey({
      name: 'workflow_version_dependencies_parent_fk',
      columns: [table.workspaceId, table.parentVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_version_dependencies_target_fk',
      columns: [
        table.workspaceId,
        table.targetWorkflowId,
        table.targetVersionId,
      ],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('restrict'),
    index('workflow_version_dependencies_target_idx').on(
      table.workspaceId,
      table.targetWorkflowId,
      table.parentVersionId,
    ),
  ],
);
