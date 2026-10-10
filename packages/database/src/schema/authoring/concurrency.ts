import { sql } from 'drizzle-orm';
import { appSchema } from '../app-schema.js';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  integer,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core';
import { workflows } from './workflows.js';

export const workflowConcurrencyPolicies = appSchema.table(
  'workflow_concurrency_policies',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    activeRunLimit: integer('active_run_limit'),
    revision: integer('revision').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_concurrency_policies_active_run_limit_check',
      sql`((active_run_limit >= 1) AND (active_run_limit <= 10000))`,
    ),
    check('workflow_concurrency_policies_revision_check', sql`(revision > 0)`),
    primaryKey({
      name: 'workflow_concurrency_policies_pkey',
      columns: [table.workspaceId, table.workflowId],
    }),
    foreignKey({
      name: 'workflow_concurrency_policies_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);
