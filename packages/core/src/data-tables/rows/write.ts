import { DataTableError } from '@pertexo/node-sdk';
import type { PoolClient } from 'pg';

import { runTableCommand } from '../command.js';
import type { ImportRowsInput, WriteRowsInput } from '../contract.js';
import { readQuotas, requireTable } from '../definitions.queries.js';
import { insertTableBatch, mutateRows } from './mutate.repository.js';

export function writeTableRows(client: PoolClient, input: WriteRowsInput) {
  // HTTP receipts retain identities/counts only; row payloads follow table access.
  return runTableCommand(client, input, {
    operation: 'data.tables.rows.write',
    audit: (result) => ({
      targetType: 'data_table',
      targetId: input.tableId,
      metadata: {
        operation: input.command.operation,
        affected: result.affected,
      },
    }),
    request: {
      tableId: input.tableId,
      command: input.command,
      rowId: input.rowId ?? null,
      expectedRevision: input.expectedRevision ?? null,
    },
    work: async () => {
      const quotas = await readQuotas(client, input.workspaceId, {
        lock: true,
      });
      const table = await requireTable(
        client,
        input.workspaceId,
        { id: input.tableId },
        { lock: true },
      );
      if (input.command.table !== table.name)
        throw new DataTableError(
          'conflict',
          'The table name does not match this command. Reload before writing.',
        );
      const result = await mutateRows(client, input.workspaceId, {
        table,
        quotas,
        command: input.command,
        rowIdentity:
          input.rowId === undefined
            ? undefined
            : { rowId: input.rowId, expectedRevision: input.expectedRevision },
      });
      return {
        rows: result.rows.map((row) => ({
          id: row.id,
          revision: row.revision,
        })),
        affected: result.affected,
      };
    },
  });
}

export function importTableRows(client: PoolClient, input: ImportRowsInput) {
  return runTableCommand(client, input, {
    operation: 'data.tables.rows.import',
    audit: (result) => ({
      targetType: 'data_table',
      targetId: input.tableId,
      metadata: { affected: result.affected },
    }),
    request:
      'prepareRows' in input
        ? { tableId: input.tableId, csv: input.csv }
        : { tableId: input.tableId, rows: input.rows },
    work: async () => {
      const quotas = await readQuotas(client, input.workspaceId, {
        lock: true,
      });
      const table = await requireTable(
        client,
        input.workspaceId,
        { id: input.tableId },
        { lock: true },
      );
      return insertTableBatch(client, input.workspaceId, {
        table,
        quotas,
        rows: 'prepareRows' in input ? input.prepareRows(table) : input.rows,
      });
    },
  });
}
