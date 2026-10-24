import { DataTableError } from '@pertexo/node-sdk';
import type { Pool } from 'pg';

import { generatePersistedId } from '../../platform/persisted-id.js';

import type { DataTablesStore } from '../contract.js';
import { readQuotas, requireTable } from '../definitions.queries.js';

import { editTableSchema } from '../columns/schema.repository.js';

import { write, command } from './session.js';

export function createTable(
  pool: Pool,
  input: Parameters<DataTablesStore['create']>[0],
): ReturnType<DataTablesStore['create']> {
  return write(pool, input, (client) =>
    command(client, input, {
      operation: 'data.tables.create',
      audit: (result) => ({
        targetType: 'data_table',
        targetId: result.id,
        metadata: { columnCount: input.columns.length },
      }),
      request: {
        name: input.name,
        columns: input.columns,
        keyColumn: input.keyColumn ?? null,
      },
      work: async () => {
        const quota = await readQuotas(client, input.workspaceId, {
          lock: true,
        });
        if (
          quota.tableCount >= quota.tableLimit ||
          input.columns.length > quota.columnLimit
        )
          throw new DataTableError(
            'quota_exceeded',
            'Table or column limit reached. Ask an admin to raise it.',
          );
        const invalidKeyColumn =
          input.keyColumn !== undefined &&
          input.keyColumn !== null &&
          !input.columns.some(
            (column) =>
              column.name === input.keyColumn &&
              column.required &&
              ['text', 'number', 'date'].includes(column.type),
          );
        if (invalidKeyColumn)
          throw new DataTableError(
            'invalid_values',
            'The unique key must be a required text, number or date column.',
          );
        const id = generatePersistedId();
        await client.query(
          'insert into app.workspace_data_tables(workspace_id,id,name,columns_json,key_column) values($1,$2,$3,$4::jsonb,$5)',
          [
            input.workspaceId,
            id,
            input.name,
            JSON.stringify(
              input.columns.map((column) => ({
                ...column,
                id: column.name,
              })),
            ),
            input.keyColumn ?? null,
          ],
        );
        await client.query(
          'update app.workspace_data_table_quotas set table_count=table_count+1 where workspace_id=$1',
          [input.workspaceId],
        );
        return { id };
      },
    }),
  );
}

export function editSchema(
  pool: Pool,
  input: Parameters<DataTablesStore['editSchema']>[0],
): ReturnType<DataTablesStore['editSchema']> {
  return write(pool, input, (client) =>
    command(client, input, {
      operation: 'data.tables.schema.edit',
      audit: null,
      request: {
        tableId: input.tableId,
        expectedRevision: input.expectedRevision,
        change: input.change,
      },
      work: () => editTableSchema(client, input),
    }),
  );
}

export function removeTable(
  pool: Pool,
  input: Parameters<DataTablesStore['remove']>[0],
): ReturnType<DataTablesStore['remove']> {
  return write(pool, input, (client) =>
    command(client, input, {
      operation: 'data.tables.remove',
      audit: () => ({ targetType: 'data_table', targetId: input.tableId }),
      request: {
        tableId: input.tableId,
        expectedRevision: input.expectedRevision,
      },
      work: async () => {
        await readQuotas(client, input.workspaceId, { lock: true });
        const table = await requireTable(
          client,
          input.workspaceId,
          { id: input.tableId },
          { lock: true },
        );
        if (table.revision !== input.expectedRevision)
          throw new DataTableError(
            'conflict',
            'This table changed. Reload before deleting.',
          );
        await client.query(
          'delete from app.workspace_data_tables where workspace_id=$1 and id=$2',
          [input.workspaceId, table.id],
        );
        await client.query(
          'update app.workspace_data_table_quotas set table_count=table_count-1,stored_bytes=stored_bytes-$2 where workspace_id=$1',
          [input.workspaceId, table.storedBytes],
        );
        return { removed: true as const };
      },
    }),
  );
}

export function configureTables(
  pool: Pool,
  input: Parameters<DataTablesStore['configure']>[0],
): ReturnType<DataTablesStore['configure']> {
  return write(
    pool,
    input,
    (client) =>
      command(client, input, {
        operation: 'data.tables.configure',
        audit: () => ({
          targetType: 'workspace',
          targetId: input.workspaceId,
          metadata: {
            tableLimit: input.tableLimit,
            columnLimit: input.columnLimit,
            rowLimit: input.rowLimit,
            byteLimit: input.byteLimit,
          },
        }),
        request: {
          tableLimit: input.tableLimit,
          columnLimit: input.columnLimit,
          rowLimit: input.rowLimit,
          byteLimit: input.byteLimit,
        },
        work: async () => {
          const current = await readQuotas(client, input.workspaceId, {
            lock: true,
          });
          const max = (
            await client.query<{ columns: number; rows: number }>(
              'select coalesce(max(jsonb_array_length(columns_json)),0)::int columns,coalesce(max(row_count),0)::int rows from app.workspace_data_tables where workspace_id=$1',
              [input.workspaceId],
            )
          ).rows[0];
          const quotasBelowCurrentUsage =
            current.tableCount > input.tableLimit ||
            current.storedBytes > input.byteLimit ||
            (max?.columns ?? 0) > input.columnLimit ||
            (max?.rows ?? 0) > input.rowLimit;
          if (quotasBelowCurrentUsage)
            throw new DataTableError(
              'quota_exceeded',
              'Limits cannot be lower than current table use.',
            );
          await client.query(
            'update app.workspace_data_table_quotas set table_limit=$2,column_limit=$3,row_limit=$4,byte_limit=$5 where workspace_id=$1',
            [
              input.workspaceId,
              input.tableLimit,
              input.columnLimit,
              input.rowLimit,
              input.byteLimit,
            ],
          );
          return readQuotas(client, input.workspaceId);
        },
      }),
    { admin: true },
  );
}
