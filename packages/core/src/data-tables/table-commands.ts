import { generatePersistedId } from '@pertexo/database/platform';
import { DataTableError, isDataTableKeyColumn } from '@pertexo/node-sdk';
import type { PoolClient } from 'pg';

import { runTableCommand } from './command.js';
import type {
  ConfigureTablesInput,
  CreateTableInput,
  RemoveTableInput,
} from './data-table-commands.types.js';
import { readQuotas } from './table-lookups.repository.js';
import { requireTable } from './require-table.js';
import {
  deleteTable,
  insertTable,
  readLargestTableUse,
  setQuotaLimits,
} from './definitions.repository.js';
import {
  configuredTablesReceipt,
  createdTableReceipt,
  removedTableReceipt,
} from './receipts.js';

export function createTable(client: PoolClient, input: CreateTableInput) {
  return runTableCommand(client, input, {
    operation: 'data.tables.create',
    receipt: createdTableReceipt,
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
      await insertTable(client, input, id, keyColumn);
      return { id };
    },
  });
}

export function removeTable(client: PoolClient, input: RemoveTableInput) {
  return runTableCommand(client, input, {
    operation: 'data.tables.remove',
    receipt: removedTableReceipt,
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
      await deleteTable(client, input.workspaceId, table);
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
    receipt: configuredTablesReceipt,
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
      const max = await readLargestTableUse(client, input.workspaceId);
      if (
        current.tableCount > input.tableLimit ||
        current.storedBytes > input.byteLimit ||
        max.columns > input.columnLimit ||
        max.rows > input.rowLimit
      )
        throw new DataTableError(
          'quota_exceeded',
          'Limits cannot be lower than current table use.',
        );
      await setQuotaLimits(client, input.workspaceId, limits);
      return readQuotas(client, input.workspaceId);
    },
  });
}
