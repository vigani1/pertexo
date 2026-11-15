import { appendAuditFact } from '../../governance/audit/facts.js';
import {
  changeDataTableDefinition,
  changeDataTableValues,
  DataTableError,
  dataTableValuesSchema,
  validateDataTableValues,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  normalizedJson,
  utf8ByteLength,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { decodeStoredValue } from '../../shared/stored-values.js';
import { runTableCommand } from '../command.js';
import { editedTableSchemaReceipt } from '../receipts.js';
import type {
  DataTableDefinition,
  DataTableQuotas,
  EditTableSchemaInput,
} from '../data-table-commands.types.js';
import { readQuotas } from '../table-lookups.repository.js';
import { requireTable } from '../require-table.js';
import { keyValue } from '../rows/key.js';
import {
  clearRowKeys,
  readRewriteBatch,
  saveTableSchema,
  writeRowChanges,
} from './edit.repository.js';

export function editSchema(client: PoolClient, input: EditTableSchemaInput) {
  return runTableCommand(client, input, {
    operation: 'data.tables.schema.edit',
    receipt: editedTableSchemaReceipt,
    audit: null,
    request: {
      tableId: input.tableId,
      expectedRevision: input.expectedRevision,
      change: input.change,
    },
    work: () => editTableSchema(client, input),
  });
}

async function editTableSchema(
  client: PoolClient,
  input: EditTableSchemaInput,
): Promise<{ revision: number }> {
  const quota = await readQuotas(client, input.workspaceId, { lock: true });
  const table = await requireTable(
    client,
    input.workspaceId,
    { id: input.tableId },
    { lock: true },
  );
  if (table.revision !== input.expectedRevision)
    throw new DataTableError(
      'conflict',
      'This table changed. Refresh before editing its columns.',
    );
  const next = changeDataTableDefinition(
    table,
    input.change,
    `col_${generatePersistedId().replaceAll('-', '')}`,
  );
  if (next.columns.length > quota.columnLimit)
    throw new DataTableError(
      'quota_exceeded',
      'Column limit reached. Ask an admin to raise it.',
    );
  if (input.change.operation === 'add_column') {
    const { column, defaultValue } = input.change;
    // Validate even an empty table: a required addition always needs its typed default.
    const missingRequiredDefault =
      column.required &&
      (defaultValue === undefined ||
        defaultValue === null ||
        (typeof defaultValue === 'string' && defaultValue.trim() === ''));
    if (missingRequiredDefault)
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
  const bytes = await rewriteTableRows(client, input, { table, next, quota });
  await saveTableSchema(client, input, { table, next, bytes });
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'data.table_schema_changed',
    targetType: 'data_table',
    targetId: table.id,
    metadata: {
      operation: input.change.operation,
      revision: next.revision,
      columns: next.columns.map(({ id, name }) => ({ id, name })),
      keyColumn: next.keyColumn,
    },
  });
  return { revision: next.revision };
}

async function rewriteTableRows(
  client: PoolClient,
  input: EditTableSchemaInput,
  {
    table,
    next,
    quota,
  }: Readonly<{
    table: DataTableDefinition;
    next: DataTableDefinition;
    quota: DataTableQuotas;
  }>,
): Promise<number> {
  // Replacing keys in two phases allows valid swaps without transient uniqueness failures.
  if (
    input.change.operation === 'set_key' &&
    next.keyColumn !== table.keyColumn
  )
    await clearRowKeys(client, input, table.id);
  let after: string | null = null;
  let bytes = 0;
  for (;;) {
    const batch = await readRewriteBatch(client, input, table.id, after);
    if (batch.length === 0) break;
    const rows = batch.map((row) => {
      const stored = decodeStoredValue(() =>
        dataTableValuesSchema.parse(JSON.parse(row.values)),
      );
      const values = changeDataTableValues(
        table.columns,
        next,
        input.change,
        stored,
      );
      const text = normalizedJson(values);
      bytes += utf8ByteLength(text);
      // Older rows were stored with sorted keys; only content counts.
      const changed = canonicalJson(values) !== canonicalJson(stored);
      return {
        id: row.id,
        values: text,
        keyValue: keyValue(next, values),
        revision: row.revision + (changed ? 1 : 0),
      };
    });
    if (quota.storedBytes - table.storedBytes + bytes > quota.byteLimit)
      throw new DataTableError(
        'quota_exceeded',
        'The column default exceeds table storage. Use a smaller value or ask an admin to raise the limit.',
      );
    await writeRowChanges(client, {
      workspaceId: input.workspaceId,
      tableId: table.id,
      changes: rows,
    });
    after = rows.at(-1)?.id ?? null;
  }
  return bytes;
}
