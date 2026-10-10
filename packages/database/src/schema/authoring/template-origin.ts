import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  jsonb,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WorkflowTemplateOrigin } from '@pertexo/templates';
import { appSchema } from '../namespace.js';
import { workflows } from './workflows.js';

export const workflowTemplateOrigins = appSchema.table(
  'workflow_template_origins',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    origin: jsonb('origin').$type<WorkflowTemplateOrigin>().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_template_origins_origin_check',
      sql`((jsonb_typeof(origin) = 'object'::text) AND (octet_length((origin)::text) <= 512))`,
    ),
    primaryKey({
      name: 'workflow_template_origins_pkey',
      columns: [table.workspaceId, table.workflowId],
    }),
    foreignKey({
      name: 'workflow_template_origins_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);
