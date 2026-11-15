import {
  DATA_TABLE_LIMITS,
  DataTableError,
  formatByteSize,
  dataTableValuesSchema,
  isDataTableResultBounded,
  validateDataTableQuery,
  type DataTableQuery,
  type DataTableResult,
  type DataTableRow,
} from '@pertexo/node-sdk';
import { and, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { decodeStoredValue } from '../../shared/stored-values.js';
import { workspaceDataTableRows as rows } from '@pertexo/database/schema';
import type {
  DataTableDefinition,
  FindRowsInput,
} from '../data-table-commands.types.js';
import { requireTable } from '../table-lookups.repository.js';

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
  const stored = decodeStoredValue(() =>
    dataTableValuesSchema.parse(JSON.parse(row.values)),
  );
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
      `The result exceeds ${formatByteSize(DATA_TABLE_LIMITS.resultBytes)} or the execution value bounds. Narrow the filter or lower the row limit.`,
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

export async function findTableRows(client: PoolClient, input: FindRowsInput) {
  return findRows(
    client,
    input.workspaceId,
    await requireTable(client, input.workspaceId, { id: input.tableId }),
    input.query,
  );
}

// An export reads at most this many rows, and this many value bytes, per checkout.
const EXPORT_BATCH_ROWS = 256;
const EXPORT_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * The next export batch after `after`. The candidate set is bounded on the
 * server; only the byte-bounded prefix crosses the wire. Even a maximum-size
 * row fits this prefix.
 */
export function readExportBatch(
  client: PoolClient,
  {
    workspaceId,
    tableId,
    where,
    after,
  }: Readonly<{
    workspaceId: string;
    tableId: string;
    where: SQL | undefined;
    after: string | null;
  }>,
) {
  const db = drizzle(client);
  const candidates = db.$with('candidates').as(
    db
      .select({ id: rows.id, valuesText: rows.values })
      .from(rows)
      .where(
        and(
          eq(rows.workspaceId, workspaceId),
          eq(rows.tableId, tableId),
          where,
          after === null ? undefined : gt(rows.id, after),
        ),
      )
      .orderBy(rows.id)
      .limit(EXPORT_BATCH_ROWS),
  );
  const sized = db.$with('sized').as(
    db
      .select({
        id: candidates.id,
        valuesText: candidates.valuesText,
        bytes:
          sql<number>`sum(octet_length(${candidates.valuesText})) over (order by ${candidates.id})`.as(
            'bytes',
          ),
      })
      .from(candidates),
  );
  return db
    .with(candidates, sized)
    .select({ id: sized.id, valuesText: sized.valuesText })
    .from(sized)
    .where(lte(sized.bytes, EXPORT_BATCH_BYTES))
    .orderBy(sized.id)
    .catch(rethrowQueryFailure);
}
