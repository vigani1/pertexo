import {
  DataTableError,
  dataTableValuesSchema,
  isDataTableResultBounded,
  validateDataTableQuery,
  type DataTableQuery,
  type DataTableResult,
  type DataTableRow,
} from '@pertexo/node-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '../platform/query-errors.js';
import { workspaceDataTableRows as rows } from '../schema/data-tables.js';
import type { DataTableDefinition } from './contract.js';

export type StoredRow = Pick<
  typeof rows.$inferSelect,
  'id' | 'revision' | 'values'
>;
export const rowFields = {
  id: rows.id,
  revision: rows.revision,
  values: rows.values,
};

/** Text values retain their stored format; output follows the table's column order. */
function projectRow(table: DataTableDefinition, row: StoredRow): DataTableRow {
  const stored = dataTableValuesSchema.parse(JSON.parse(row.values));
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

export function queryClause(table: DataTableDefinition, query: DataTableQuery) {
  validateDataTableQuery(table.columns, query);
  return and(
    ...query.filters.map((filter) => {
      const cell = sql`(${rows.values}::jsonb -> ${filter.column}::text)`;
      const value = sql`${JSON.stringify(filter.value)}::jsonb`;
      switch (filter.operator) {
        case 'equals':
          return sql`${cell} = ${value}`;
        case 'not_equals':
          return sql`${cell} is distinct from ${value}`;
        // ASCII letters fold, as workflow search does (ADR 064).
        case 'contains':
          return sql`strpos(lower((${rows.values}::jsonb ->> ${filter.column}::text) collate "C"),lower((${value} #>> '{}') collate "C"))>0`;
        case 'greater_than':
          return sql`${cell} > ${value}`;
        case 'less_than':
          return sql`${cell} < ${value}`;
      }
    }),
  );
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
      'The result exceeds 1 MB or the execution value bounds. Narrow the filter or lower the row limit.',
    );
  return result;
}
function rowOrderClause(query: DataTableQuery) {
  if (query.sort === undefined) return [rows.id];
  const direction = query.sort.direction === 'desc' ? sql`desc` : sql`asc`;
  return [
    sql`${rows.values}::jsonb -> ${query.sort.column}::text ${direction} nulls last`,
    rows.id,
  ];
}

export async function findRows(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableQuery,
): Promise<DataTableResult> {
  const found = await drizzle(client)
    .select(rowFields)
    .from(rows)
    .where(
      and(
        eq(rows.workspaceId, workspaceId),
        eq(rows.tableId, table.id),
        queryClause(table, query),
      ),
    )
    .orderBy(...rowOrderClause(query))
    .limit(query.limit + 1)
    .offset(query.offset)
    .catch(rethrowQueryFailure);
  return boundedResult(
    found.slice(0, query.limit).map((row) => projectRow(table, row)),
    Math.min(found.length, query.limit),
    { hasMore: found.length > query.limit },
  );
}
