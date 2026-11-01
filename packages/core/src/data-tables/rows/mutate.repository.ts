import { generatePersistedId } from '@pertexo/database/platform';
import {
  isUniqueConstraintFailure,
  queryFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  workspaceDataTableQuotas as quotasTable,
  workspaceDataTableRows as tableRows,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import {
  DataTableError,
  dataTableValuesSchema,
  validateDataTableValues,
  type DataTableResult,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { normalizedJson, utf8ByteLength } from '@pertexo/workflow-model';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type {
  DataTableDefinition,
  DataTableQuotas,
  DataTableWriteCommand,
} from '../contract.js';
import { boundedResult, type StoredRow } from './find.queries.js';
import { keyConflictMessage, keyValue } from './key.js';
import { lockMutationRows, type RowIdentity } from './lock.queries.js';

/** Where a change goes: every step acts on one table in one transaction. */
type TableTarget = Readonly<{
  client: PoolClient;
  workspaceId: string;
  table: DataTableDefinition;
}>;

/** What a write did, and what it adds to the table's and workspace's totals. */
type RowChange = Readonly<{
  result: DataTableResult;
  countDelta: number;
  byteDelta: number;
}>;

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
    command: DataTableWriteCommand;
    rowIdentity?: RowIdentity | undefined;
  }>,
): Promise<DataTableResult> {
  const old = await lockMutationRows(client, workspaceId, {
    table,
    command,
    rowIdentity,
  });
  const { result, countDelta, byteDelta } = await applyChange(
    { client, workspaceId, table },
    command,
    old,
  );
  if (result.affected > 0)
    await chargeMutation(client, workspaceId, {
      table,
      quotas,
      countDelta,
      byteDelta,
    });
  return result;
}

function applyChange(
  target: TableTarget,
  command: DataTableWriteCommand,
  old: readonly StoredRow[],
): Promise<RowChange> {
  if (command.operation === 'delete') return deleteRows(target, old);
  if (
    command.operation === 'insert' ||
    (command.operation === 'upsert' && old.length === 0)
  )
    return insertRow(target, command.values);
  return patchRows(target, command, old);
}

async function deleteRows(
  { client, workspaceId, table }: TableTarget,
  old: readonly StoredRow[],
): Promise<RowChange> {
  if (old.length > 0)
    await drizzle(client)
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
  return {
    result: boundedResult([], old.length),
    countDelta: -old.length,
    byteDelta: -old.reduce((sum, row) => sum + utf8ByteLength(row.values), 0),
  };
}

async function insertRow(
  { client, workspaceId, table }: TableTarget,
  input: DataTableValues,
): Promise<RowChange> {
  const values = validateDataTableValues(table.columns, input);
  const text = normalizedJson(values);
  const id = generatePersistedId();
  const result = boundedResult([{ id, revision: 1, values }], 1);
  await drizzle(client)
    .insert(tableRows)
    .values({
      workspaceId,
      tableId: table.id,
      id,
      values: text,
      keyValue: keyValue(table, values),
    })
    .catch((error: unknown) => rowKeyConflict(error, table, values));
  return { result, countDelta: 1, byteDelta: utf8ByteLength(text) };
}

// An existing row keeps every column the command doesn't name.
async function patchRows(
  { client, workspaceId, table }: TableTarget,
  command: Extract<DataTableWriteCommand, { values: DataTableValues }>,
  old: readonly StoredRow[],
): Promise<RowChange> {
  const patch = validateDataTableValues(table.columns, command.values, {
    partial: true,
  });
  let byteDelta = 0;
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
    await drizzle(client)
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
      .catch((error: unknown) => rowKeyConflict(error, table, first.values));
  return {
    result: boundedResult(
      command.operation === 'upsert'
        ? updates.map(({ id, revision, values }) => ({ id, revision, values }))
        : [],
      old.length,
    ),
    countDelta: 0,
    byteDelta,
  };
}

function rowKeyConflict(
  caught: unknown,
  table: DataTableDefinition,
  values: DataTableValues,
): never {
  if (!isUniqueConstraintFailure(caught) || table.keyColumn === null)
    throw queryFailure(caught);
  throw new DataTableError(
    'key_conflict',
    keyConflictMessage(table.keyColumn, values),
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
  if (records.length > 0)
    await drizzle(client)
      .insert(tableRows)
      .values(
        records.map((row) => ({ workspaceId, tableId: table.id, ...row })),
      )
      .catch(rethrowQueryFailure);
  return { affected: records.length };
}
