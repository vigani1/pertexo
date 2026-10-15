import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from './namespace.js';
import { workspaces } from './foundation.js';
export const workspaceVariables = appSchema.table(
  'workspace_variables',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    revision: integer('revision').notNull(),
    values: jsonb('values_json').notNull(),
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
    check('workspace_variables_revision_positive', sql`revision>0`),
    check(
      'workspace_variables_values_bounded',
      sql`jsonb_typeof(values_json)='object' AND octet_length(values_json::text)<=65536`,
    ),
  ],
);
