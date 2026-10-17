import type { PoolClient } from 'pg';
import {
  DataTableError,
  isDataTableResultBounded,
  validateDataTableQuery,
  type DataTableQuery,
  type DataTableRow,
  type DataTableResult,
  type DataTableValues,
} from '@pertexo/node-sdk';
import type { DataTableDefinition } from './contract.js';
export interface StoredRow {
  id: string;
  revision: number;
  values_json: string;
}
function projectRow(row: StoredRow): DataTableRow {
  return {
    id: row.id,
    revision: row.revision,
    values: JSON.parse(row.values_json) as DataTableValues,
  };
}
export function queryClause(
  table: DataTableDefinition,
  query: DataTableQuery,
  parameters: unknown[],
): string {
  validateDataTableQuery(table.columns, query);
  const parameter = (value: unknown) => {
    parameters.push(value);
    return `$${String(parameters.length)}`;
  };
  return (
    query.filters
      .map((filter) => {
        const column = parameter(filter.column);
        const value = parameter(JSON.stringify(filter.value));
        const cell = `(values_json::jsonb -> ${column}::text)`;
        switch (filter.operator) {
          case 'equals':
            return `${cell} = ${value}::jsonb`;
          case 'not_equals':
            return `${cell} is distinct from ${value}::jsonb`;
          case 'contains':
            return `strpos(values_json::jsonb ->> ${column}::text,${value}::jsonb #>> '{}')>0`;
          case 'greater_than':
            return `${cell} > ${value}::jsonb`;
          case 'less_than':
            return `${cell} < ${value}::jsonb`;
        }
      })
      .join(' and ') || 'true'
  );
}
export function boundedResult(
  rows: readonly DataTableRow[],
  affected: number,
  hasMore = false,
): DataTableResult {
  const result = { rows: [...rows], affected, hasMore };
  if (!isDataTableResultBounded(result))
    throw new DataTableError(
      'result_too_large',
      'The result exceeds 1 MB or the execution value bounds. Narrow the filter or lower the row limit.',
    );
  return result;
}
export async function findRows(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableQuery,
): Promise<DataTableResult> {
  const parameters: unknown[] = [workspaceId, table.id];
  const where = queryClause(table, query, parameters);
  let order = 'id';
  if (query.sort !== undefined) {
    parameters.push(query.sort.column);
    order = `values_json::jsonb -> $${String(parameters.length)}::text ${query.sort.direction === 'desc' ? 'desc' : 'asc'} nulls last,id`;
  }
  parameters.push(query.limit + 1, query.offset);
  const result = await client.query<StoredRow>(
    `select id,revision,values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and ${where} order by ${order} limit $${String(parameters.length - 1)} offset $${String(parameters.length)}`,
    parameters,
  );
  return boundedResult(
    result.rows.slice(0, query.limit).map(projectRow),
    Math.min(result.rows.length, query.limit),
    result.rows.length > query.limit,
  );
}
