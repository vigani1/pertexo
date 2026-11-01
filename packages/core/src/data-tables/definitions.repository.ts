import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceDataTableQuotas as quotas,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import { DataTableError, isDataTableKeyColumn } from '@pertexo/node-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { runTableCommand } from './command.js';
import type {
  ConfigureTablesInput,
  CreateTableInput,
  RemoveTableInput,
} from './contract.js';
import { readQuotas, requireTable } from './definitions.queries.js';

export function createTable(client: PoolClient, input: CreateTableInput) {
  return runTableCommand(client, input, {
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
      const quota = await readQuotas(client, input.workspaceId, { lock: true });
      if (
        quota.tableCount >= quota.tableLimit ||
        input.columns.length > quota.columnLimit
      )
        throw new DataTableError(
          'quota_exceeded',
          'Table or column limit reached. Ask an admin to raise it.',
        );
      const keyColumn = input.keyColumn ?? null;
      if (
        keyColumn !== null &&
        !input.columns.some(
          (column) => column.name === keyColumn && isDataTableKeyColumn(column),
        )
      )
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
          keyColumn,
        })
        .catch(rethrowQueryFailure);
      await db
        .update(quotas)
        .set({ tableCount: sql`${quotas.tableCount}+1` })
        .where(eq(quotas.workspaceId, input.workspaceId))
        .catch(rethrowQueryFailure);
      return { id };
    },
  });
}

export function removeTable(client: PoolClient, input: RemoveTableInput) {
  return runTableCommand(client, input, {
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
  });
}

export function configureTables(
  client: PoolClient,
  input: ConfigureTablesInput,
) {
  const limits = {
    tableLimit: input.tableLimit,
    columnLimit: input.columnLimit,
    rowLimit: input.rowLimit,
    byteLimit: input.byteLimit,
  };
  return runTableCommand(client, input, {
    operation: 'data.tables.configure',
    audit: () => ({
      targetType: 'workspace',
      targetId: input.workspaceId,
      metadata: limits,
    }),
    request: limits,
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
      if (
        current.tableCount > input.tableLimit ||
        current.storedBytes > input.byteLimit ||
        (max?.columns ?? 0) > input.columnLimit ||
        (max?.rows ?? 0) > input.rowLimit
      )
        throw new DataTableError(
          'quota_exceeded',
          'Limits cannot be lower than current table use.',
        );
      await db
        .update(quotas)
        .set(limits)
        .where(eq(quotas.workspaceId, input.workspaceId))
        .catch(rethrowQueryFailure);
      return readQuotas(client, input.workspaceId);
    },
  });
}
