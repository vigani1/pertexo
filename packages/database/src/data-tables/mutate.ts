import type { PoolClient } from 'pg';
import { canonicalJson, normalizedJson } from '@pertexo/workflow-model';
import {
  DataTableError,
  DATA_TABLE_LIMITS,
  validateDataTableValues,
  type DataTableCommand,
  type DataTableValues,
  type DataTableResult,
} from '@pertexo/node-sdk';
import { generatePersistedId } from '../platform/persisted-id.js';
import type { DataTableDefinition, DataTableQuotas } from './contract.js';
import { boundedResult, queryClause, type StoredRow } from './queries.js';
export function keyValue(
  table: DataTableDefinition,
  values: DataTableValues,
): string | null {
  if (table.keyColumn === null) return null;
  const key = canonicalJson(values[table.keyColumn]);
  if (Buffer.byteLength(key) > 1024)
    throw new DataTableError(
      'invalid_values',
      'A unique key must fit 1 KiB. Use a shorter identifier.',
    );
  return key;
}
export async function mutateRows(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  quotas: DataTableQuotas,
  command: Exclude<DataTableCommand, { operation: 'find' }>,
  rowIdentity?: Readonly<{ rowId: string; expectedRevision: number }>,
): Promise<DataTableResult> {
  let old: StoredRow[] = [];
  let countDelta = 0;
  let byteDelta = 0;
  if (command.operation === 'upsert') {
    if (table.keyColumn === null)
      throw new DataTableError(
        'invalid_values',
        'Upsert needs a table with a unique key column.',
      );
    // Only the key finds the row; other required columns apply on insert.
    const values = validateDataTableValues(table.columns, command.values, true);
    if ((values[table.keyColumn] ?? null) === null)
      throw new DataTableError(
        'invalid_values',
        `Column ${table.keyColumn} is required.`,
      );
    const key = keyValue(table, values);
    old = (
      await client.query<StoredRow>(
        'select id,revision,values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and key_value=$3 for update',
        [workspaceId, table.id, key],
      )
    ).rows;
  } else if (command.operation === 'update' || command.operation === 'delete') {
    if (rowIdentity !== undefined) {
      old = (
        await client.query<StoredRow>(
          'select id,revision,values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and id=$3 for update',
          [workspaceId, table.id, rowIdentity.rowId],
        )
      ).rows;
      if (old[0]?.revision !== rowIdentity.expectedRevision)
        throw new DataTableError(
          'conflict',
          'This row changed. Reload before saving.',
        );
    } else {
      if (command.query.filters.length === 0)
        throw new DataTableError(
          'unsafe_filter',
          'Choose at least one filter before updating or deleting rows.',
        );
      if (command.query.sort !== undefined)
        throw new DataTableError(
          'invalid_values',
          'Sorting applies to Find rows; writes affect every matching row.',
        );
      if (command.query.offset !== 0)
        throw new DataTableError(
          'invalid_values',
          'Writes do not support a row offset.',
        );
      const parameters: unknown[] = [workspaceId, table.id];
      const where = queryClause(table, command.query, parameters);
      old = (
        await client.query<StoredRow>(
          `select id,revision,values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and ${where} order by id limit 1001 for update`,
          parameters,
        )
      ).rows;
      if (old.length > DATA_TABLE_LIMITS.batchRows)
        throw new DataTableError(
          'quota_exceeded',
          'More than 1,000 rows match. Narrow the filter or split the operation.',
        );
    }
  }
  let result: DataTableResult;
  if (command.operation === 'delete') {
    if (old.length > 0)
      await client.query(
        'delete from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and id=any($3::uuid[])',
        [workspaceId, table.id, old.map((row) => row.id)],
      );
    countDelta = -old.length;
    byteDelta = -old.reduce(
      (sum, row) => sum + Buffer.byteLength(row.values_json),
      0,
    );
    result = boundedResult([], old.length);
  } else if (
    command.operation === 'insert' ||
    (command.operation === 'upsert' && old.length === 0)
  ) {
    const values = validateDataTableValues(table.columns, command.values);
    const text = normalizedJson(values);
    const id = generatePersistedId();
    countDelta = 1;
    byteDelta = Buffer.byteLength(text);
    result = boundedResult([{ id, revision: 1, values }], 1);
    await client.query(
      'insert into app.workspace_data_table_rows(workspace_id,table_id,id,values_json,key_value) values($1,$2,$3,$4,$5)',
      [workspaceId, table.id, id, text, keyValue(table, values)],
    );
  } else {
    // An existing row keeps every column the command doesn't name.
    const patch = validateDataTableValues(table.columns, command.values, true);
    const outputs = [];
    for (const row of old) {
      const values = validateDataTableValues(table.columns, {
        ...(JSON.parse(row.values_json) as DataTableValues),
        ...patch,
      });
      const text = normalizedJson(values);
      byteDelta += Buffer.byteLength(text) - Buffer.byteLength(row.values_json);
      await client.query(
        'update app.workspace_data_table_rows set values_json=$4,key_value=$5,revision=revision+1 where workspace_id=$1 and table_id=$2 and id=$3',
        [workspaceId, table.id, row.id, text, keyValue(table, values)],
      );
      if (command.operation === 'upsert')
        outputs.push({ id: row.id, revision: row.revision + 1, values });
    }
    result = boundedResult(outputs, old.length);
  }
  if (result.affected === 0) return result;
  await chargeMutation(
    client,
    workspaceId,
    table,
    quotas,
    countDelta,
    byteDelta,
  );
  return result;
}
export function translateTableConstraint(error: unknown): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  )
    throw new DataTableError(
      'key_conflict',
      'A table or row already uses that name or unique key.',
    );
  throw error;
}

async function chargeMutation(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  quotas: DataTableQuotas,
  countDelta: number,
  byteDelta: number,
): Promise<void> {
  if (
    table.rowCount + countDelta > quotas.rowLimit ||
    quotas.storedBytes + byteDelta > quotas.byteLimit
  )
    throw new DataTableError(
      'quota_exceeded',
      'Data table storage is full. Remove rows, split the data or ask an admin to raise the limit.',
    );
  await client.query(
    'update app.workspace_data_tables set row_count=row_count+$3,stored_bytes=stored_bytes+$4,revision=revision+1 where workspace_id=$1 and id=$2',
    [workspaceId, table.id, countDelta, byteDelta],
  );
  await client.query(
    'update app.workspace_data_table_quotas set stored_bytes=stored_bytes+$2 where workspace_id=$1',
    [workspaceId, byteDelta],
  );
}
export async function insertTableBatch(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  quotas: DataTableQuotas,
  rows: readonly DataTableValues[],
): Promise<{ affected: number }> {
  const records = rows.map((input, index) => {
    try {
      const values = validateDataTableValues(table.columns, input);
      return {
        id: generatePersistedId(),
        values_json: normalizedJson(values),
        key_value: keyValue(table, values),
      };
    } catch (error) {
      if (error instanceof DataTableError)
        throw new DataTableError(error.code, error.message, index + 1);
      throw error;
    }
  });
  const bytes = records.reduce(
    (sum, row) => sum + Buffer.byteLength(row.values_json),
    0,
  );
  await chargeMutation(
    client,
    workspaceId,
    table,
    quotas,
    records.length,
    bytes,
  );
  await client.query(
    `insert into app.workspace_data_table_rows(workspace_id,table_id,id,values_json,key_value)
 select $1,$2,row.id,row.values_json,row.key_value from jsonb_to_recordset($3::jsonb) as row(id uuid,values_json text,key_value text)`,
    [workspaceId, table.id, JSON.stringify(records)],
  );
  return { affected: records.length };
}
