import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceDataTableRows as tableRows } from '@pertexo/database/schema';
import {
  DATA_TABLE_LIMITS,
  DataTableError,
  validateDataTableValues,
  type DataTableQuery,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type {
  DataTableDefinition,
  DataTableWriteCommand,
} from '../contract.js';
import { queryClause, rowFields, type StoredRow } from './find.queries.js';
import { keyValue } from './key.js';

export type RowIdentity = Readonly<{ rowId: string; expectedRevision: number }>;

/** Locks the rows a write will change; an insert has none. */
export function lockMutationRows(
  client: PoolClient,
  workspaceId: string,
  {
    table,
    command,
    rowIdentity,
  }: Readonly<{
    table: DataTableDefinition;
    command: DataTableWriteCommand;
    rowIdentity?: RowIdentity | undefined;
  }>,
): Promise<StoredRow[]> {
  switch (command.operation) {
    case 'insert':
      return Promise.resolve([]);
    case 'upsert':
      return lockKeyedRow(client, workspaceId, table, command.values);
    case 'update':
    case 'delete':
      return rowIdentity === undefined
        ? lockFilteredRows(client, workspaceId, table, command.query)
        : lockNamedRow(client, workspaceId, table, rowIdentity);
  }
}

// Only the key finds the row; other required columns apply on insert.
async function lockKeyedRow(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  input: DataTableValues,
): Promise<StoredRow[]> {
  if (table.keyColumn === null)
    throw new DataTableError(
      'invalid_values',
      'Upsert needs a table with a unique key column.',
    );
  const values = validateDataTableValues(table.columns, input, {
    partial: true,
  });
  if ((values[table.keyColumn] ?? null) === null)
    throw new DataTableError(
      'invalid_values',
      `Column ${table.keyColumn} is required.`,
    );
  const key = keyValue(table, values);
  return drizzle(client)
    .select(rowFields)
    .from(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, table.id),
        eq(tableRows.keyValue, sql`${key}::text`),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}

async function lockNamedRow(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  { rowId, expectedRevision }: RowIdentity,
): Promise<StoredRow[]> {
  const rows = await drizzle(client)
    .select(rowFields)
    .from(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, table.id),
        eq(tableRows.id, rowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (rows[0]?.revision !== expectedRevision)
    throw new DataTableError(
      'conflict',
      'This row changed. Reload before saving.',
    );
  return rows;
}

async function lockFilteredRows(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableQuery,
): Promise<StoredRow[]> {
  requireWriteQuery(query);
  const rows = await drizzle(client)
    .select(rowFields)
    .from(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, table.id),
        queryClause(table, query),
      ),
    )
    .orderBy(tableRows.id)
    .limit(DATA_TABLE_LIMITS.batchRows + 1)
    .for('update')
    .catch(rethrowQueryFailure);
  if (rows.length > DATA_TABLE_LIMITS.batchRows)
    throw new DataTableError(
      'quota_exceeded',
      `More than ${DATA_TABLE_LIMITS.batchRows.toLocaleString('en-US')} rows match. Narrow the filter or split the operation.`,
    );
  return rows;
}

/** A write affects every matching row, so only a filter may narrow it. */
function requireWriteQuery(query: DataTableQuery): void {
  if (query.filters.length === 0)
    throw new DataTableError(
      'unsafe_filter',
      'Choose at least one filter before updating or deleting rows.',
    );
  if (query.sort !== undefined)
    throw new DataTableError(
      'invalid_values',
      'Sorting applies to Find rows; writes affect every matching row.',
    );
  if (query.offset !== 0)
    throw new DataTableError(
      'invalid_values',
      'Writes do not support a row offset.',
    );
}
