import { alias } from 'drizzle-orm/pg-core';
import { utf8ByteLength } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  workspaceDataTables as tables,
  workspaceDataTableRows as tableRows,
  workspaceDataTableQuotas as quotas,
} from '../../schema/data-tables.js';
import { auditEvents } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { DataTableSchemaChange } from '@pertexo/contracts';
import {
  DataTableError,
  validateDataTableValues,
  type DataTableColumn,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { canonicalJson, normalizedJson } from '@pertexo/workflow-model';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { readQuotas, requireTable } from '../definitions.queries.js';
import { keyValue } from '../rows.repository.js';
import type {
  DataTablesStore,
  DataTableDefinition,
  DataTableQuotas,
} from '../contract.js';

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
      const invalidKeyColumn =
        change.columnId !== null &&
        (column === undefined ||
          !column.required ||
          !['text', 'number', 'date'].includes(column.type));
      if (invalidKeyColumn)
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
  const next = changedDefinition(table, input.change);
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
  const db = drizzle(client);
  await db
    .update(tables)
    .set({
      columns: next.columns,
      keyColumn: next.keyColumn,
      hasRemovedColumns: next.hasRemovedColumns,
      storedBytes: bytes,
      revision: sql`${tables.revision}+1`,
    })
    .where(
      and(eq(tables.workspaceId, input.workspaceId), eq(tables.id, table.id)),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(quotas)
    .set({
      storedBytes: sql`${quotas.storedBytes}+${bytes - table.storedBytes}`,
    })
    .where(eq(quotas.workspaceId, input.workspaceId))
    .catch(rethrowQueryFailure);
  await db
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: 'data.table_schema_changed',
      targetType: 'data_table',
      targetId: table.id,
      metadata: {
        operation: input.change.operation,
        revision: next.revision,
        columns: next.columns.map(({ id, name }) => ({ id, name })),
        keyColumn: next.keyColumn,
      },
    })
    .catch(rethrowQueryFailure);
  return { revision: next.revision };
}

async function rewriteTableRows(
  client: PoolClient,
  input: Parameters<DataTablesStore['editSchema']>[0],
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
  const db = drizzle(client);
  // Replacing keys in two phases allows valid swaps without transient uniqueness failures.
  if (
    input.change.operation === 'set_key' &&
    next.keyColumn !== table.keyColumn
  )
    await db
      .update(tableRows)
      .set({ keyValue: null })
      .where(
        and(
          eq(tableRows.workspaceId, input.workspaceId),
          eq(tableRows.tableId, table.id),
        ),
      )
      .catch(rethrowQueryFailure);
  let after: string | null = null;
  let bytes = 0;
  for (;;) {
    const batch: Pick<
      typeof tableRows.$inferSelect,
      'id' | 'values' | 'revision'
    >[] = await db
      .select({
        id: tableRows.id,
        values: tableRows.values,
        revision: tableRows.revision,
      })
      .from(tableRows)
      .where(
        and(
          eq(tableRows.workspaceId, input.workspaceId),
          eq(tableRows.tableId, table.id),
          after === null ? undefined : gt(tableRows.id, after),
        ),
      )
      .orderBy(tableRows.id)
      .limit(64)
      .catch(rethrowQueryFailure);
    if (batch.length === 0) break;
    const rows = batch.map((row) => {
      const values = changedValues(
        table.columns,
        next,
        input.change,
        JSON.parse(row.values) as DataTableValues,
      );
      const text = normalizedJson(values);
      bytes += utf8ByteLength(text);
      // Older rows were stored with sorted keys; only content counts.
      const changed =
        canonicalJson(values) !==
        canonicalJson(JSON.parse(row.values) as DataTableValues);
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
    await writeRowChanges(db, {
      workspaceId: input.workspaceId,
      tableId: table.id,
      changes: rows,
    });
    after = rows.at(-1)?.id ?? null;
  }
  return bytes;
}

type RowChange = Pick<
  typeof tableRows.$inferSelect,
  'id' | 'values' | 'keyValue' | 'revision'
>;

async function writeRowChanges(
  db: NodePgDatabase,
  {
    workspaceId,
    tableId,
    changes,
  }: Readonly<{
    workspaceId: string;
    tableId: string;
    changes: readonly RowChange[];
  }>,
): Promise<void> {
  // The table lock keeps these IDs present, so a bulk upsert preserves the
  // existing-row rewrite without issuing a write for each row.
  const excluded = alias(tableRows, 'excluded');
  await db
    .insert(tableRows)
    .values(changes.map((row) => ({ workspaceId, tableId, ...row })))
    .onConflictDoUpdate({
      target: tableRows.id,
      set: {
        values: excluded.values,
        keyValue: excluded.keyValue,
        revision: excluded.revision,
      },
      setWhere: sql`${tableRows.workspaceId}=${workspaceId} and ${tableRows.tableId}=${tableId}`,
    })
    .catch(rethrowQueryFailure);
}
