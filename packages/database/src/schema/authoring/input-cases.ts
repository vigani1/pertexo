import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows, workflowVersions } from './workflows.js';

export const workflowInputCases = appSchema.table(
  'workflow_input_cases',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    versionChecksum: varchar('version_checksum', { length: 74 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`date_trunc('milliseconds',clock_timestamp())`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_input_cases_name_check',
      sql`((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))`,
    ),
    check('workflow_input_cases_revision_check', sql`(revision > 0)`),
    unique('workflow_input_cases_workspace_id_id_key').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'workflow_input_cases_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    foreignKey({
      name: 'workflow_input_cases_workspace_id_workflow_id_workflow_ver_fkey',
      columns: [table.workspaceId, table.workflowId, table.workflowVersionId],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }),
    index('workflow_input_cases_page_idx')
      .on(table.workspaceId, table.workflowId, table.createdAt, table.id)
      .where(sql`(deleted_at IS NULL)`),
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
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_input_case_payloads_canonical_bytes_check',
      sql`((canonical_bytes >= 1) AND (canonical_bytes <= 65536))`,
    ),
    check(
      'workflow_input_case_payloads_check',
      sql`(octet_length(input) = canonical_bytes)`,
    ),
    check(
      'workflow_input_case_payloads_input_check',
      sql`((input)::jsonb IS NOT NULL)`,
    ),
    check('workflow_input_case_payloads_revision_check', sql`(revision > 0)`),
    primaryKey({
      name: 'workflow_input_case_payloads_pkey',
      columns: [table.workspaceId, table.caseId, table.revision],
    }),
    foreignKey({
      name: 'workflow_input_case_payloads_workspace_id_case_id_fkey',
      columns: [table.workspaceId, table.caseId],
      foreignColumns: [workflowInputCases.workspaceId, workflowInputCases.id],
    }),
  ],
);
