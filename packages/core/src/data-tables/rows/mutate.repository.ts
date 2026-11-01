import {
  DATA_TABLE_LIMITS,
  DataTableError,
  dataTableValuesSchema,
  validateDataTableValues,
  type DataTableCommand,
  type DataTableResult,
  type DataTableValues,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  normalizedJson,
  utf8ByteLength,
} from '@pertexo/workflow-model';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  isUniqueConstraintFailure,
  postgresFailure,
  queryFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  workspaceDataTableQuotas as quotasTable,
  workspaceDataTableRows as tableRows,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import type { DataTableDefinition, DataTableQuotas } from '../contract.js';
import {
  boundedResult,
  queryClause,
  rowFields,
  type StoredRow,
} from './find.queries.js';
export function keyValue(
  table: DataTableDefinition,
  values: DataTableValues,
): string | null {
  if (table.keyColumn === null) return null;
  const key = canonicalJson(values[table.keyColumn]);
  if (utf8ByteLength(key) > 1024)
    throw new DataTableError(
      'invalid_values',
      'A unique key must fit 1 KiB. Use a shorter identifier.',
    );
  return key;
}
export async function mutateRows(
  client: PoolClient,
  workspaceId: string,
  {
    table,
    quotas,
    command,
    rowIdentity,
  }: Readonly<{
    table: DataTableDefinition;
    quotas: DataTableQuotas;
    command: Exclude<DataTableCommand, { operation: 'find' }>;
    rowIdentity?:
      Readonly<{ rowId: string; expectedRevision: number }> | undefined;
  }>,
): Promise<DataTableResult> {
  const db = drizzle(client);
  const old = await lockMutationRows(client, workspaceId, {
    table,
    command,
    rowIdentity,
  });
  let countDelta = 0;
  let byteDelta = 0;
  let result: DataTableResult;
  if (command.operation === 'delete') {
    if (old.length > 0)
      await db
        .delete(tableRows)
        .where(
          and(
            eq(tableRows.workspaceId, workspaceId),
            eq(tableRows.tableId, table.id),
            inArray(
              tableRows.id,
              old.map((row) => row.id),
            ),
          ),
        )
        .catch(rethrowQueryFailure);
    countDelta = -old.length;
    byteDelta = -old.reduce((sum, row) => sum + utf8ByteLength(row.values), 0);
    result = boundedResult([], old.length);
  } else {
    const insertsRow =
      command.operation === 'insert' ||
      (command.operation === 'upsert' && old.length === 0);
    if (insertsRow) {
      const values = validateDataTableValues(table.columns, command.values);
      const text = normalizedJson(values);
      const id = generatePersistedId();
      countDelta = 1;
      byteDelta = utf8ByteLength(text);
      result = boundedResult([{ id, revision: 1, values }], 1);
      await db
        .insert(tableRows)
        .values({
          workspaceId,
          tableId: table.id,
          id,
          values: text,
          keyValue: keyValue(table, values),
        })
        .catch((error: unknown) => rowKeyConflict(error, table, values));
    } else {
      // An existing row keeps every column the command doesn't name.
      const patch = validateDataTableValues(table.columns, command.values, {
        partial: true,
      });
      const updates = old.map((row) => {
        const values = validateDataTableValues(table.columns, {
          ...dataTableValuesSchema.parse(JSON.parse(row.values)),
          ...patch,
        });
        const text = normalizedJson(values);
        byteDelta += utf8ByteLength(text) - utf8ByteLength(row.values);
        return {
          id: row.id,
          revision: row.revision + 1,
          values,
          text,
          keyValue: keyValue(table, values),
        };
      });
      const [first] = updates;
      if (first !== undefined)
        await db
          .update(tableRows)
          .set({
            values: sql`batch.values_json`,
            keyValue: sql`batch.key_value`,
            revision: sql`${tableRows.revision}+1`,
          })
          .from(
            sql`unnest(${sql.param(updates.map(({ id }) => id))}::uuid[],${sql.param(updates.map(({ text }) => text))}::text[],${sql.param(updates.map((update) => update.keyValue))}::text[]) as batch(id,values_json,key_value)`,
          )
          .where(
            and(
              eq(tableRows.workspaceId, workspaceId),
              eq(tableRows.tableId, table.id),
              sql`${tableRows.id}=batch.id`,
            ),
          )
          // Only a patch that names the key can clash, and it gives every row that key.
          .catch((error: unknown) =>
            rowKeyConflict(error, table, first.values),
          );
      result = boundedResult(
        command.operation === 'upsert'
          ? updates.map(({ id, revision, values }) => ({
              id,
              revision,
              values,
            }))
          : [],
        old.length,
      );
    }
  }
  if (result.affected === 0) return result;
  await chargeMutation(client, workspaceId, {
    table,
    quotas,
    countDelta,
    byteDelta,
  });
  return result;
}
export function translateTableConstraint(caught: unknown): never {
  const { code, constraint } = postgresFailure(caught);
  if (code === '23505')
    throw new DataTableError(
      'key_conflict',
      constraint === 'workspace_data_tables_name'
        ? 'A table with this name already exists. Choose another name.'
        : 'Another row already uses this unique key.',
    );
  throw queryFailure(caught);
}

/** Names the clash, since the person writing the row sent this key. */
function rowKeyConflict(
  caught: unknown,
  table: DataTableDefinition,
  values: DataTableValues,
): never {
  if (!isUniqueConstraintFailure(caught) || table.keyColumn === null)
    throw queryFailure(caught);
  const key = values[table.keyColumn];
  const shown =
    typeof key === 'string'
      ? `“${key.length > 64 ? `${key.slice(0, 63)}…` : key}”`
      : JSON.stringify(key);
  throw new DataTableError(
    'key_conflict',
    `A row with ${table.keyColumn} ${shown} already exists.`,
  );
}

async function chargeMutation(
  client: PoolClient,
  workspaceId: string,
  {
    table,
    quotas,
    countDelta,
    byteDelta,
  }: Readonly<{
    table: DataTableDefinition;
    quotas: DataTableQuotas;
    countDelta: number;
    byteDelta: number;
  }>,
): Promise<void> {
  if (
    table.rowCount + countDelta > quotas.rowLimit ||
    quotas.storedBytes + byteDelta > quotas.byteLimit
  )
    throw new DataTableError(
      'quota_exceeded',
      'Data table storage is full. Remove rows, split the data or ask an admin to raise the limit.',
    );
  const db = drizzle(client);
  await db
    .update(tables)
    .set({
      rowCount: sql`${tables.rowCount}+${countDelta}`,
      storedBytes: sql`${tables.storedBytes}+${byteDelta}`,
      revision: sql`${tables.revision}+1`,
    })
    .where(and(eq(tables.workspaceId, workspaceId), eq(tables.id, table.id)))
    .catch(rethrowQueryFailure);
  await db
    .update(quotasTable)
    .set({ storedBytes: sql`${quotasTable.storedBytes}+${byteDelta}` })
    .where(eq(quotasTable.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
}
export async function insertTableBatch(
  client: PoolClient,
  workspaceId: string,
  {
    table,
    quotas,
    rows,
  }: Readonly<{
    table: DataTableDefinition;
    quotas: DataTableQuotas;
    rows: readonly DataTableValues[];
  }>,
): Promise<{ affected: number }> {
  const records = rows.map((input, index) => {
    try {
      const values = validateDataTableValues(table.columns, input);
      return {
        id: generatePersistedId(),
        values: normalizedJson(values),
        keyValue: keyValue(table, values),
      };
    } catch (error) {
      if (error instanceof DataTableError)
        throw new DataTableError(error.code, error.message, index + 1);
      throw error;
    }
  });
  const bytes = records.reduce(
    (sum, row) => sum + utf8ByteLength(row.values),
    0,
  );
  await chargeMutation(client, workspaceId, {
    table,
    quotas,
    countDelta: records.length,
    byteDelta: bytes,
  });
  const db = drizzle(client);
  if (records.length > 0)
    await db
      .insert(tableRows)
      .values(
        records.map((row) => ({ workspaceId, tableId: table.id, ...row })),
      )
      .catch(rethrowQueryFailure);
  return { affected: records.length };
}

async function lockMutationRows(
  client: PoolClient,
  workspaceId: string,
  {
    table,
    command,
    rowIdentity,
  }: Readonly<{
    table: DataTableDefinition;
    command: Exclude<DataTableCommand, { operation: 'find' }>;
    rowIdentity?:
      Readonly<{ rowId: string; expectedRevision: number }> | undefined;
  }>,
): Promise<StoredRow[]> {
  const db = drizzle(client);
  let old: StoredRow[] = [];
  if (command.operation === 'upsert') {
    if (table.keyColumn === null)
      throw new DataTableError(
        'invalid_values',
        'Upsert needs a table with a unique key column.',
      );
    // Only the key finds the row; other required columns apply on insert.
    const values = validateDataTableValues(table.columns, command.values, {
      partial: true,
    });
    if ((values[table.keyColumn] ?? null) === null)
      throw new DataTableError(
        'invalid_values',
        `Column ${table.keyColumn} is required.`,
      );
    const key = keyValue(table, values);
    old = await db
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
  } else if (command.operation === 'update' || command.operation === 'delete') {
    if (rowIdentity !== undefined) {
      old = await db
        .select(rowFields)
        .from(tableRows)
        .where(
          and(
            eq(tableRows.workspaceId, workspaceId),
            eq(tableRows.tableId, table.id),
            eq(tableRows.id, rowIdentity.rowId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
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
      old = await db
        .select(rowFields)
        .from(tableRows)
        .where(
          and(
            eq(tableRows.workspaceId, workspaceId),
            eq(tableRows.tableId, table.id),
            queryClause(table, command.query),
          ),
        )
        .orderBy(tableRows.id)
        .limit(DATA_TABLE_LIMITS.batchRows + 1)
        .for('update')
        .catch(rethrowQueryFailure);
      if (old.length > DATA_TABLE_LIMITS.batchRows)
        throw new DataTableError(
          'quota_exceeded',
          'More than 1,000 rows match. Narrow the filter or split the operation.',
        );
    }
  }

  return old;
}
