import {
  DATA_TABLE_LIMITS,
  DataTableError,
  formatByteSize,
  dataTableValuesSchema,
  isDataTableResultBounded,
  validateDataTableQuery,
  type DataTableQuery,
  type DataTableResult,
  type DataTableRow,
} from '@pertexo/node-sdk';
import type { PoolClient } from 'pg';
import { decodeStoredValue } from '../../shared/stored-values.js';
import type {
  DataTableDefinition,
  FindRowsInput,
} from '../data-table-commands.types.js';
import { requireTable } from '../require-table.js';
import { readRowPage, type StoredRow } from './find.repository.js';

export async function findRows(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableQuery,
): Promise<DataTableResult> {
  validateDataTableQuery(table.columns, query);
  const found = await readRowPage(client, workspaceId, table, query);
  return boundedResult(
    found.slice(0, query.limit).map((row) => projectRow(table, row)),
    Math.min(found.length, query.limit),
    { hasMore: found.length > query.limit },
  );
}

export async function findTableRows(client: PoolClient, input: FindRowsInput) {
  return findRows(
    client,
    input.workspaceId,
    await requireTable(client, input.workspaceId, { id: input.tableId }),
    input.query,
  );
}

/** Text values retain their stored format; output follows the table's column order. */
function projectRow(table: DataTableDefinition, row: StoredRow): DataTableRow {
  const stored = decodeStoredValue(() =>
    dataTableValuesSchema.parse(JSON.parse(row.values)),
  );
  return {
    id: row.id,
    revision: row.revision,
    values: Object.fromEntries(
      table.columns
        .filter(({ name }) => Object.hasOwn(stored, name))
        .map(({ name }) => [name, stored[name] ?? null]),
    ),
  };
}

export function boundedResult(
  rows: readonly DataTableRow[],
  affected: number,
  { hasMore = false }: Readonly<{ hasMore?: boolean | undefined }> = {},
): DataTableResult {
  const result = { rows: [...rows], affected, hasMore };
  if (!isDataTableResultBounded(result))
    throw new DataTableError(
      'result_too_large',
      `The result exceeds ${formatByteSize(DATA_TABLE_LIMITS.resultBytes)} or the execution value bounds. Narrow the filter or lower the row limit.`,
    );
  return result;
}
