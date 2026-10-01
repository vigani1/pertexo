import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from './app-schema.js';
import { workflows } from './authoring.js';
import { workspaces } from './foundation.js';

export const workflowInputCaseRollout = appSchema.table(
  'workflow_input_case_rollout',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    enabled: boolean('enabled').notNull().default(false),
  },
);
export const workflowManualStartRejections = appSchema.table(
  'workflow_manual_start_rejections',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    workflowId: uuid('workflow_id').notNull(),
    scope: varchar('scope', { length: 128 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    expectedVersionId: uuid('expected_version_id').notNull(),
    observedVersionId: uuid('observed_version_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()+interval '24 hours'`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.scope, table.keyHash] }),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    index('workflow_manual_start_rejections_expiry_idx').on(
      table.expiresAt,
      table.workspaceId,
      table.scope,
      table.keyHash,
    ),
  ],
);
