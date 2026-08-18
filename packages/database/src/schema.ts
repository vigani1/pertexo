import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

export const rlsProbeRecords = appSchema.table(
  'rls_probe_records',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('rls_probe_records_workspace_idx').on(table.workspaceId, table.id),
  ],
);

export const databaseSchema = { rlsProbeRecords };
