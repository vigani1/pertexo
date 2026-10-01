import { sql } from 'drizzle-orm';
import { appSchema } from './app-schema.js';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { workflows } from './authoring.js';
import { workspaces } from './foundation.js';

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
export const workflowConcurrencyCommandReceipts = appSchema.table(
  'workflow_concurrency_command_receipts',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    keyHash: text('key_hash').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`clock_timestamp()+interval '24 hours'`),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.actorId,
        table.workflowId,
        table.keyHash,
      ],
    }),
    index('workflow_concurrency_receipts_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.result} is not null`),
  ],
);
