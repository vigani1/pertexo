import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from './namespace.js';
import { workspaces } from './foundation.js';

export const workspaceVariableSetRevisions = appSchema.table(
  'workspace_variable_set_revisions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    revision: integer('revision').notNull(),
    values: jsonb('values_json').$type<WorkspaceVariableValues>().notNull(),
    descriptions: jsonb('descriptions_json')
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.revision] }),
    foreignKey({
      name: 'workspace_variable_sets_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check('workspace_variable_sets_revision_positive', sql`revision>0`),
    check(
      'workspace_variable_sets_values_bounded',
      sql`jsonb_typeof(values_json)='object' AND octet_length(values_json::text)<=65536`,
    ),
    check(
      'workspace_variable_sets_descriptions_bounded',
      sql`jsonb_typeof(descriptions_json)='object' AND octet_length(descriptions_json::text)<=32768`,
    ),
  ],
);
export const workspaceVariables = appSchema.table(
  'workspace_variables',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    foreignKey({
      name: 'workspace_variables_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_variables_set_fk',
      columns: [table.workspaceId, table.revision],
      foreignColumns: [
        workspaceVariableSetRevisions.workspaceId,
        workspaceVariableSetRevisions.revision,
      ],
    }),
    check('workspace_variables_revision_positive', sql`revision>0`),
  ],
);
