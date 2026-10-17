import { DATA_TABLE_LIMITS } from '@pertexo/node-sdk';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  unique,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { appSchema } from './namespace.js';
import { workspaces } from './foundation.js';
import { workflowRuns, previewRuns } from './runs/execution.js';

export const workspaceDataTableQuotas = appSchema.table(
  'workspace_data_table_quotas',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    tableLimit: integer('table_limit')
      .notNull()
      .default(DATA_TABLE_LIMITS.tables),
    columnLimit: integer('column_limit')
      .notNull()
      .default(DATA_TABLE_LIMITS.columns),
    rowLimit: integer('row_limit').notNull().default(DATA_TABLE_LIMITS.rows),
    byteLimit: integer('byte_limit').notNull().default(DATA_TABLE_LIMITS.bytes),
    tableCount: integer('table_count').notNull().default(0),
    storedBytes: integer('stored_bytes').notNull().default(0),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check(
      'data_table_quotas_bounds',
      sql`table_limit between 1 and 100 and column_limit between 1 and 50 and row_limit between 1 and 100000 and byte_limit between 65536 and 1073741824 and table_count between 0 and table_limit and stored_bytes between 0 and byte_limit`,
    ),
  ],
);
export const workspaceDataTables = appSchema.table(
  'workspace_data_tables',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid().primaryKey(),
    name: varchar({ length: 64 }).notNull(),
    columns: jsonb('columns_json').notNull(),
    keyColumn: varchar('key_column', { length: 64 }),
    rowCount: integer('row_count').notNull().default(0),
    storedBytes: integer('stored_bytes').notNull().default(0),
    revision: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('workspace_data_tables_identity').on(t.workspaceId, t.id),
    unique('workspace_data_tables_name').on(t.workspaceId, t.name),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check(
      'workspace_data_tables_bounds',
      sql`name ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' and jsonb_typeof(columns_json)='array' and jsonb_array_length(columns_json) between 1 and 50 and octet_length(columns_json::text)<=16384 and row_count between 0 and 100000 and stored_bytes>=0 and revision>0`,
    ),
  ],
);
export const workspaceDataTableRows = appSchema.table(
  'workspace_data_table_rows',
  {
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    id: uuid().primaryKey(),
    values: text('values_json').notNull(),
    keyValue: text('key_value'),
    revision: integer().notNull().default(1),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.tableId],
      foreignColumns: [workspaceDataTables.workspaceId, workspaceDataTables.id],
    }).onDelete('cascade'),
    unique('workspace_data_table_rows_key').on(
      t.workspaceId,
      t.tableId,
      t.keyValue,
    ),
    check(
      'workspace_data_table_rows_bounds',
      sql`octet_length(values_json)<=65536 and jsonb_typeof(values_json::jsonb)='object' and (key_value is null or octet_length(key_value)<=1024) and revision>0`,
    ),
    index('workspace_data_table_rows_page').on(t.workspaceId, t.tableId, t.id),
  ],
);
export const dataTableWriteReceipts = appSchema.table(
  'data_table_write_receipts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    invocationId: uuid('invocation_id').notNull(),
    runId: uuid('run_id'),
    previewRunId: uuid('preview_run_id'),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    result: text('result_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.executionId, t.invocationId] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.previewRunId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
    }).onDelete('cascade'),
    index('data_table_receipts_run_idx')
      .on(t.workspaceId, t.runId)
      .where(sql`run_id is not null`),
    index('data_table_receipts_preview_idx')
      .on(t.workspaceId, t.previewRunId)
      .where(sql`preview_run_id is not null`),
    check(
      'data_table_receipts_bounds',
      sql`(run_id is null)<>(preview_run_id is null) and execution_id=coalesce(run_id,preview_run_id) and request_hash ~ '^[0-9a-f]{64}$' and octet_length(result_json)<=1048576`,
    ),
  ],
);
