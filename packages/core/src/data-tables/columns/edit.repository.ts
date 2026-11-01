import {
  appendAuditFact,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
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
import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  workspaceDataTableQuotas as quotas,
  workspaceDataTableRows as tableRows,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import { runTableCommand } from '../command.js';
import type {
  DataTableDefinition,
  DataTableQuotas,
  EditTableSchemaInput,
} from '../contract.js';
import { readQuotas, requireTable } from '../definitions.queries.js';
import { keyValue } from '../rows/key.js';

/** Rows rewrite in batches of this many. */
const REWRITE_BATCH_ROWS = 64;

export function editSchema(client: PoolClient, input: EditTableSchemaInput) {
  return runTableCommand(client, input, {
    operation: 'data.tables.schema.edit',
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
      .limit(REWRITE_BATCH_ROWS)
      .catch(rethrowQueryFailure);
    if (batch.length === 0) break;
    const rows = batch.map((row) => {
      const stored = dataTableValuesSchema.parse(JSON.parse(row.values));
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
