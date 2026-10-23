import type { PoolClient } from 'pg';
import {
  DataTableError,
  DATA_TABLE_LIMITS,
  type DataTableColumn,
} from '@pertexo/node-sdk';
import type { DataTableDefinition, DataTableQuotas } from './contract.js';
export interface StoredTable extends Record<string, unknown> {
  id: string;
  name: string;
  columns_json: DataTableColumn[];
  has_removed_columns: boolean;
  key_column: string | null;
  row_count: number;
  stored_bytes: number;
  revision: number;
}
export const TABLE_COLUMNS =
  'id,name,columns_json,has_removed_columns,key_column,row_count,stored_bytes,revision';
export function projectTable(row: StoredTable): DataTableDefinition {
  return {
    id: row.id,
    name: row.name,
    columns: row.columns_json,
    hasRemovedColumns: row.has_removed_columns,
    keyColumn: row.key_column,
    rowCount: row.row_count,
    storedBytes: row.stored_bytes,
    revision: row.revision,
  };
}
export async function requireTable(
  client: PoolClient,
  workspaceId: string,
  identity: { id: string } | { name: string },
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<DataTableDefinition> {
  const byId = 'id' in identity;
  const result = await client.query<StoredTable>(
    `select ${TABLE_COLUMNS} from app.workspace_data_tables where workspace_id=$1 and ${byId ? 'id' : 'name'}=$2${lock ? ' for update' : ''}`,
    [workspaceId, byId ? identity.id : identity.name],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new DataTableError(
      'not_found',
      'This data table is unavailable. Select an existing workspace table.',
    );
  return projectTable(row);
}
export async function readQuotas(
  client: PoolClient,
  workspaceId: string,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<DataTableQuotas> {
  if (lock)
    await client.query(
      'insert into app.workspace_data_table_quotas(workspace_id) values($1) on conflict do nothing',
      [workspaceId],
    );
  const result = await client.query<{
    table_limit: number;
    column_limit: number;
    row_limit: number;
    byte_limit: number;
    table_count: number;
    stored_bytes: number;
  }>(
    `select * from app.workspace_data_table_quotas where workspace_id=$1${lock ? ' for update' : ''}`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row === undefined
    ? {
        tableLimit: DATA_TABLE_LIMITS.tables,
        columnLimit: DATA_TABLE_LIMITS.columns,
        rowLimit: DATA_TABLE_LIMITS.rows,
        byteLimit: DATA_TABLE_LIMITS.bytes,
        tableCount: 0,
        storedBytes: 0,
      }
    : {
        tableLimit: row.table_limit,
        columnLimit: row.column_limit,
        rowLimit: row.row_limit,
        byteLimit: row.byte_limit,
        tableCount: row.table_count,
        storedBytes: row.stored_bytes,
      };
}
