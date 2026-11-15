import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceDataTableRows as tableRows } from '@pertexo/database/schema';
import { DATA_TABLE_LIMITS, type DataTableQuery } from '@pertexo/node-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { DataTableDefinition } from '../data-table-commands.types.js';
import { queryClause, rowFields, type StoredRow } from './find.repository.js';

export function lockRowsByKey(
  client: PoolClient,
  workspaceId: string,
  tableId: string,
  key: string | null,
): Promise<StoredRow[]> {
  return drizzle(client)
    .select(rowFields)
    .from(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, tableId),
        eq(tableRows.keyValue, sql`${key}::text`),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}

export function lockRowById(
  client: PoolClient,
  workspaceId: string,
  tableId: string,
  rowId: string,
): Promise<StoredRow[]> {
  return drizzle(client)
    .select(rowFields)
    .from(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, tableId),
        eq(tableRows.id, rowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}

/** The matching rows in ID order, one past the batch cap so an overfull match shows. */
export function lockMatchingRows(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableQuery,
): Promise<StoredRow[]> {
  return drizzle(client)
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
}
