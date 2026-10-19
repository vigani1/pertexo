import type { PoolClient, QueryResult } from 'pg';
import type { DataTableSchemaChange } from '@pertexo/contracts';
import {
  DataTableError,
  validateDataTableValues,
  type DataTableColumn,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { canonicalJson, normalizedJson } from '@pertexo/workflow-model';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { readQuotas, requireTable } from '../read.js';
import { keyValue } from '../mutate.js';
import type { DataTablesStore, DataTableDefinition } from '../contract.js';

function changedDefinition(
  table: DataTableDefinition,
  change: DataTableSchemaChange,
): DataTableDefinition {
  const columns = table.columns.map((column) => ({ ...column }));
  let keyColumn = table.keyColumn;
  let hasRemovedColumns = table.hasRemovedColumns;
  switch (change.operation) {
    case 'add_column':
      if (columns.some((column) => column.name === change.column.name))
        throw new DataTableError(
          'invalid_values',
          'A column already uses that name.',
        );
      columns.push({
        ...change.column,
        id: `col_${generatePersistedId().replaceAll('-', '')}`,
      });
      break;
    case 'rename_column': {
      const column = columns.find((column) => column.id === change.columnId);
      if (column === undefined)
        throw new DataTableError(
          'invalid_values',
          'This column was removed. Refresh the table.',
        );
      if (
        columns.some(
          (other) => other.id !== column.id && other.name === change.name,
        )
      )
        throw new DataTableError(
          'invalid_values',
          'A column already uses that name.',
        );
      if (keyColumn === column.name) keyColumn = change.name;
      column.name = change.name;
      break;
    }
    case 'remove_column': {
      const index = columns.findIndex(
        (column) => column.id === change.columnId,
      );
      const removed = columns[index];
      if (removed === undefined)
        throw new DataTableError(
          'invalid_values',
          'This column was removed. Refresh the table.',
        );
      if (columns.length === 1)
        throw new DataTableError(
          'invalid_values',
          'Keep at least one column. Delete the table to remove all its data.',
        );
      columns.splice(index, 1);
      if (keyColumn === removed.name) keyColumn = null;
      hasRemovedColumns = true;
      break;
    }
    case 'set_key': {
      const column = columns.find((column) => column.id === change.columnId);
      if (
        change.columnId !== null &&
        (column === undefined ||
          !column.required ||
          !['text', 'number', 'date'].includes(column.type))
      )
        throw new DataTableError(
          'invalid_values',
          'The unique key must be a required text, number or date column.',
        );
      keyColumn = column?.name ?? null;
      break;
    }
  }
  return {
    ...table,
    columns,
    keyColumn,
    hasRemovedColumns,
    revision: table.revision + 1,
  };
}

function changedValues(
  oldColumns: readonly DataTableColumn[],
  table: DataTableDefinition,
  change: DataTableSchemaChange,
  values: DataTableValues,
): DataTableValues {
  const next = Object.fromEntries(
    table.columns.map((column) => {
      const old = oldColumns.find((candidate) => candidate.id === column.id);
      return [
        column.name,
        old === undefined && change.operation === 'add_column'
          ? (change.defaultValue ?? null)
          : (values[old?.name ?? column.name] ?? null),
      ];
    }),
  );
  return validateDataTableValues(table.columns, next);
}

export async function editTableSchema(
  client: PoolClient,
  input: Parameters<DataTablesStore['editSchema']>[0],
): Promise<{ revision: number }> {
  const quota = await readQuotas(client, input.workspaceId, true);
  const table = await requireTable(
    client,
    input.workspaceId,
    { id: input.tableId },
    true,
  );
  if (table.revision !== input.expectedRevision)
    throw new DataTableError(
      'conflict',
      'This table changed. Refresh before editing its columns.',
    );
  const next = changedDefinition(table, input.change);
  if (next.columns.length > quota.columnLimit)
    throw new DataTableError(
      'quota_exceeded',
      'Column limit reached. Ask an admin to raise it.',
    );
  if (input.change.operation === 'add_column') {
    const { column, defaultValue } = input.change;
    // Validate even an empty table: a required addition always needs its typed default.
    if (
      column.required &&
      (defaultValue === undefined ||
        defaultValue === null ||
        (typeof defaultValue === 'string' && defaultValue.trim() === ''))
    )
      throw new DataTableError(
        'invalid_values',
        `Give the required column ${column.name} a default for existing rows.`,
      );
    validateDataTableValues([column], {
      [column.name]: defaultValue ?? null,
    });
  }
  if (
    canonicalJson({ columns: table.columns, keyColumn: table.keyColumn }) ===
    canonicalJson({ columns: next.columns, keyColumn: next.keyColumn })
  )
    return { revision: table.revision };
  // Replacing keys in two phases allows valid swaps without transient uniqueness failures.
  if (
    input.change.operation === 'set_key' &&
    next.keyColumn !== table.keyColumn
  )
    await client.query(
      'update app.workspace_data_table_rows set key_value=null where workspace_id=$1 and table_id=$2',
      [input.workspaceId, table.id],
    );
  let after: string | null = null;
  let bytes = 0;
  for (;;) {
    const batch: QueryResult<{ id: string; values_json: string }> =
      await client.query(
        'select id,values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and ($3::uuid is null or id>$3::uuid) order by id limit 64',
        [input.workspaceId, table.id, after],
      );
    if (batch.rows.length === 0) break;
    const rows = batch.rows.map((row) => {
      const values = changedValues(
        table.columns,
        next,
        input.change,
        JSON.parse(row.values_json) as DataTableValues,
      );
      const text = normalizedJson(values);
      bytes += Buffer.byteLength(text);
      return {
        id: row.id,
        values_json: text,
        key_value: keyValue(next, values),
        // Older rows were stored with sorted keys; only content counts.
        changed:
          canonicalJson(values) !==
          canonicalJson(JSON.parse(row.values_json) as DataTableValues),
      };
    });
    if (quota.storedBytes - table.storedBytes + bytes > quota.byteLimit)
      throw new DataTableError(
        'quota_exceeded',
        'The column default exceeds table storage. Use a smaller value or ask an admin to raise the limit.',
      );
    await client.query(
      `update app.workspace_data_table_rows target set values_json=source.values_json,key_value=source.key_value,revision=target.revision+case when source.changed then 1 else 0 end
      from jsonb_to_recordset($3::jsonb) as source(id uuid,values_json text,key_value text,changed boolean)
      where target.workspace_id=$1 and target.table_id=$2 and target.id=source.id`,
      [input.workspaceId, table.id, JSON.stringify(rows)],
    );
    after = rows.at(-1)?.id ?? null;
  }
  await client.query(
    'update app.workspace_data_tables set columns_json=$3::jsonb,key_column=$4,has_removed_columns=$5,stored_bytes=$6,revision=revision+1 where workspace_id=$1 and id=$2',
    [
      input.workspaceId,
      table.id,
      JSON.stringify(next.columns),
      next.keyColumn,
      next.hasRemovedColumns,
      bytes,
    ],
  );
  await client.query(
    'update app.workspace_data_table_quotas set stored_bytes=stored_bytes+$2 where workspace_id=$1',
    [input.workspaceId, bytes - table.storedBytes],
  );
  await client.query(
    `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,metadata)
    values($1,$2,$3,'data.table_schema_changed','data_table',$4,$5::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      table.id,
      JSON.stringify({
        operation: input.change.operation,
        revision: next.revision,
        columns: next.columns.map(({ id, name }) => ({ id, name })),
        keyColumn: next.keyColumn,
      }),
    ],
  );
  return { revision: next.revision };
}
