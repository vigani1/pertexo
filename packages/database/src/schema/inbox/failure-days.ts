import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';

/** Exact retained ordinary-run failures, grouped by workflow and UTC day. */
export const workspaceInboxFailureDays = appSchema.table(
  'workspace_inbox_failure_days',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    count: bigint('count', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workflowId, table.day] }),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    check('workspace_inbox_failure_days_count_positive', sql`count>0`),
    index('workspace_inbox_failure_days_expiry_idx').on(
      table.day,
      table.workspaceId,
      table.workflowId,
    ),
  ],
);
