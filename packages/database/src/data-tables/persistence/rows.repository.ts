import { DataTableError } from '@pertexo/node-sdk';
import type { Pool } from 'pg';

import type { DataTablesStore } from '../contract.js';
import { readQuotas, requireTable } from '../read.js';

import { mutateRows, insertTableBatch } from '../mutate.js';
import { write, command } from './session.js';

export function writeTableRows(
  pool: Pool,
  input: Parameters<DataTablesStore['write']>[0],
): ReturnType<DataTablesStore['write']> {
  return write(pool, input, async (client) => {
    // HTTP receipts retain identities/counts only; row payloads follow table access.
    const receipt = await command(
      client,
      input,
      'data.tables.rows.write',
      (result) => ({
        targetType: 'data_table',
        targetId: input.tableId,
        metadata: {
          operation: input.command.operation,
          affected: result.affected,
        },
      }),
      {
        tableId: input.tableId,
        command: input.command,
        rowId: input.rowId ?? null,
        expectedRevision: input.expectedRevision ?? null,
      },
      async () => {
        const quotas = await readQuotas(client, input.workspaceId, true);
        const table = await requireTable(
          client,
          input.workspaceId,
          { id: input.tableId },
          true,
        );
        if (input.command.table !== table.name)
          throw new DataTableError(
            'conflict',
            'The table name does not match this command. Reload before writing.',
          );
        const result = await mutateRows(
          client,
          input.workspaceId,
          table,
          quotas,
          input.command,
          input.rowId === undefined
            ? undefined
            : {
                rowId: input.rowId,
                expectedRevision: input.expectedRevision ?? 0,
              },
        );
        return {
          rows: result.rows.map((row) => ({
            id: row.id,
            revision: row.revision,
          })),
          affected: result.affected,
        };
      },
    );
    return receipt;
  });
}

export function importTableRows(
  pool: Pool,
  input: Parameters<DataTablesStore['importRows']>[0],
): ReturnType<DataTablesStore['importRows']> {
  return write(pool, input, (client) =>
    command(
      client,
      input,
      'data.tables.rows.import',
      (result) => ({
        targetType: 'data_table',
        targetId: input.tableId,
        metadata: { affected: result.affected },
      }),
      'prepareRows' in input
        ? { tableId: input.tableId, csv: input.csv }
        : { tableId: input.tableId, rows: input.rows },
      async () => {
        const quota = await readQuotas(client, input.workspaceId, true);
        const table = await requireTable(
          client,
          input.workspaceId,
          { id: input.tableId },
          true,
        );
        return insertTableBatch(
          client,
          input.workspaceId,
          table,
          quota,
          'prepareRows' in input ? input.prepareRows(table) : input.rows,
        );
      },
    ),
  );
}
