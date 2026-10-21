import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { RUN_VALUE_LIMITS } from '@pertexo/node-sdk';
import { appSchema } from '../namespace.js';
import { workflowRuns, previewRuns } from './execution.js';

export const workflowRunValues = appSchema.table(
  'workflow_run_values',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    previewRunId: uuid('preview_run_id'),
    key: varchar('key', { length: RUN_VALUE_LIMITS.keyCharacters }).notNull(),
    value: varchar('value', {
      length: RUN_VALUE_LIMITS.valueCharacters,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'workflow_run_values_one_owner',
      sql`(workflow_run_id IS NULL) <> (preview_run_id IS NULL)`,
    ),
    foreignKey({
      name: 'workflow_run_values_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_run_values_preview_fk',
      columns: [table.workspaceId, table.previewRunId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
    }).onDelete('cascade'),
    unique('workflow_run_values_run_key').on(
      table.workspaceId,
      table.workflowRunId,
      table.key,
    ),
    unique('workflow_run_values_preview_key').on(
      table.workspaceId,
      table.previewRunId,
      table.key,
    ),
    index('workflow_run_values_lookup_idx').on(
      table.workspaceId,
      table.key,
      table.value,
      table.workflowRunId,
    ),
  ],
);
