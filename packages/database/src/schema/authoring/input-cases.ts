import { sql } from 'drizzle-orm';
import {
  uuid,
  varchar,
  integer,
  timestamp,
  text,
  foreignKey,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../app-schema.js';
import { workflows, workflowVersions } from './workflows.js';

export const workflowInputCases = appSchema.table(
  'workflow_input_cases',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    versionChecksum: varchar('version_checksum', { length: 77 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`date_trunc('milliseconds',clock_timestamp())`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('workflow_input_cases_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    foreignKey({
      columns: [table.workspaceId, table.workflowId, table.workflowVersionId],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }),
    index('workflow_input_cases_page_idx')
      .on(table.workspaceId, table.workflowId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
  ],
);
export const workflowInputCasePayloads = appSchema.table(
  'workflow_input_case_payloads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    caseId: uuid('case_id').notNull(),
    revision: integer('revision').notNull(),
    input: text('input').notNull(),
    canonicalBytes: integer('canonical_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.caseId, table.revision] }),
    foreignKey({
      columns: [table.workspaceId, table.caseId],
      foreignColumns: [workflowInputCases.workspaceId, workflowInputCases.id],
    }),
  ],
);
