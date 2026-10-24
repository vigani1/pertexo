import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from './workflows.js';

export const workflowStepSamples = appSchema.table(
  'workflow_step_samples',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: varchar('node_id', { length: 64 }).notNull(),
    binding: text('binding').notNull(),
    outputRef: text('output_ref').notNull(),
    retainedBytes: integer('retained_bytes').notNull(),
    sourceKind: varchar('source_kind', { length: 16 })
      .$type<'json' | 'run' | 'preview' | 'webhook_test'>()
      .notNull(),
    sourceRunId: uuid('source_run_id'),
    sourceNodeRunId: uuid('source_node_run_id'),
    sourcePreviewId: uuid('source_preview_id'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    unique('workflow_step_samples_step_key').on(
      table.workspaceId,
      table.workflowId,
      table.nodeId,
    ),
    unique('workflow_step_samples_workspace_id_id_key').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'workflow_step_samples_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    check(
      'workflow_step_samples_bytes_valid',
      sql`retained_bytes = octet_length(binding) + octet_length(output_ref) AND retained_bytes > 0 AND retained_bytes <= 1310800`,
    ),
    check(
      'workflow_step_samples_output_valid',
      sql`octet_length(output_ref) <= 262200 AND jsonb_typeof(output_ref::jsonb) = 'object' AND output_ref::jsonb->>'kind' = 'inline' AND output_ref::jsonb ? 'value'`,
    ),
    check(
      'workflow_step_samples_source_valid',
      sql`((source_kind IN ('json','webhook_test') AND source_run_id IS NULL AND source_node_run_id IS NULL AND source_preview_id IS NULL) OR (source_kind='run' AND source_run_id IS NOT NULL AND source_node_run_id IS NOT NULL AND source_preview_id IS NULL) OR (source_kind='preview' AND source_run_id IS NULL AND source_node_run_id IS NULL AND source_preview_id IS NOT NULL)) IS TRUE`,
    ),
    check('workflow_step_samples_expiry_valid', sql`expires_at > created_at`),
    index('workflow_step_samples_expiry_idx').on(table.expiresAt, table.id),
  ],
);
