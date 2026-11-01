import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceDataTables as tables,
  workspaceDataTableQuotas as quotas,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { DataTableError } from '@pertexo/node-sdk';
import type { Pool } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

import type { DataTablesStore } from '../contract.js';
import { readQuotas, requireTable } from '../definitions.queries.js';

import { editTableSchema } from '../columns/edit.repository.js';

import { write, command } from '../command.js';

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
        const db = drizzle(client);
        await db
          .insert(tables)
          .values({
            workspaceId: input.workspaceId,
            id,
            name: input.name,
            columns: input.columns.map((column) => ({
              ...column,
              id: column.name,
            })),
            keyColumn: input.keyColumn ?? null,
          })
          .catch(rethrowQueryFailure);
        await db
          .update(quotas)
          .set({ tableCount: sql`${quotas.tableCount}+1` })
          .where(eq(quotas.workspaceId, input.workspaceId))
          .catch(rethrowQueryFailure);
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
        const db = drizzle(client);
        await db
          .delete(tables)
          .where(
            and(
              eq(tables.workspaceId, input.workspaceId),
              eq(tables.id, table.id),
            ),
          )
          .catch(rethrowQueryFailure);
        await db
          .update(quotas)
          .set({
            tableCount: sql`${quotas.tableCount}-1`,
            storedBytes: sql`${quotas.storedBytes}-${table.storedBytes}`,
          })
          .where(eq(quotas.workspaceId, input.workspaceId))
          .catch(rethrowQueryFailure);
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
          const db = drizzle(client);
          const [max] = await db
            .select({
              columns: sql<number>`coalesce(max(jsonb_array_length(${tables.columns})),0)::int`,
              rows: sql<number>`coalesce(max(${tables.rowCount}),0)::int`,
            })
            .from(tables)
            .where(eq(tables.workspaceId, input.workspaceId))
            .catch(rethrowQueryFailure);
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
          await db
            .update(quotas)
            .set({
              tableLimit: input.tableLimit,
              columnLimit: input.columnLimit,
              rowLimit: input.rowLimit,
              byteLimit: input.byteLimit,
            })
            .where(eq(quotas.workspaceId, input.workspaceId))
            .catch(rethrowQueryFailure);
          return readQuotas(client, input.workspaceId);
        },
      }),
    { admin: true },
  );
}
