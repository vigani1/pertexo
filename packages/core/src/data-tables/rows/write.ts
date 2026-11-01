import { DataTableError } from '@pertexo/node-sdk';
import type { Pool } from 'pg';

import type { DataTablesStore } from '../contract.js';
import { readQuotas, requireTable } from '../definitions.queries.js';

import { mutateRows, insertTableBatch } from './mutate.repository.js';
import { write, command } from '../command.js';

export function writeTableRows(
  pool: Pool,
  input: Parameters<DataTablesStore['write']>[0],
): ReturnType<DataTablesStore['write']> {
  return write(pool, input, async (client) => {
    // HTTP receipts retain identities/counts only; row payloads follow table access.
    const receipt = await command(client, input, {
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
              : {
                  rowId: input.rowId,
                  expectedRevision: input.expectedRevision,
                },
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
    return receipt;
  });
}

export function importTableRows(
  pool: Pool,
  input: Parameters<DataTablesStore['importRows']>[0],
): ReturnType<DataTablesStore['importRows']> {
  return write(pool, input, (client) =>
    command(client, input, {
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
        const quota = await readQuotas(client, input.workspaceId, {
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
          quotas: quota,
          rows: 'prepareRows' in input ? input.prepareRows(table) : input.rows,
        });
      },
    }),
  );
}
