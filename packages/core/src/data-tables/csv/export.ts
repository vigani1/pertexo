import type {
  DataTableDefinition,
  DataTableExportQuery,
} from '@pertexo/contracts';
import {
  DataTableError,
  dataTableValuesSchema,
  escapeCsvValue,
} from '@pertexo/node-sdk';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceDataTableRows as rows } from '@pertexo/database/schema';
import type { ExportTableInput } from '../contract.js';
import { requireTable } from '../definitions.queries.js';
import { queryClause } from '../rows/find.queries.js';

const BATCH_ROWS = 256;
const BATCH_BYTES = 4 * 1024 * 1024;
type ExportRead = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export async function exportTable(read: ExportRead, input: ExportTableInput) {
  const table = await read((client) =>
    requireTable(client, input.workspaceId, { id: input.tableId }),
  );
  const csv = exportTableCsv(read, input.workspaceId, {
    table,
    query: input.query,
    signal: input.signal,
  });
  await input.consume(csv, table);
}

/** Each checkout finishes before yielding any bytes to the consumer. */
function exportTableCsv(
  read: ExportRead,
  workspaceId: string,
  {
    table,
    query,
    signal,
  }: Readonly<{
    table: DataTableDefinition;
    query: DataTableExportQuery;
    signal?: AbortSignal | undefined;
  }>,
): AsyncGenerator<string> {
  // Reject stale filters before the consumer starts a download.
  const where = queryClause(table, { ...query, limit: 1, offset: 0 });
  const columns = JSON.stringify(table.columns);
  return encodeRows();

  async function* encodeRows(): AsyncGenerator<string> {
    signal?.throwIfAborted();
    yield table.columns.map((column) => escapeCsvValue(column.name)).join(',') +
      '\r\n';
    let after: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const batch = await read(async (client) => {
        const current = await requireTable(client, workspaceId, {
          id: table.id,
        });
        if (JSON.stringify(current.columns) !== columns)
          throw new DataTableError(
            'conflict',
            'The table columns changed during export. Download it again.',
          );
        // The candidate set is bounded on the server; only the byte-bounded prefix
        // crosses the wire. Even a maximum-size row fits this prefix.
        const db = drizzle(client);
        const candidates = db.$with('candidates').as(
          db
            .select({ id: rows.id, valuesText: rows.values })
            .from(rows)
            .where(
              and(
                eq(rows.workspaceId, workspaceId),
                eq(rows.tableId, table.id),
                where,
                after === null ? undefined : gt(rows.id, after),
              ),
            )
            .orderBy(rows.id)
            .limit(BATCH_ROWS),
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
          .where(lte(sized.bytes, BATCH_BYTES))
          .orderBy(sized.id)
          .catch(rethrowQueryFailure);
      });
      if (batch.length === 0) return;
      for (const row of batch) {
        signal?.throwIfAborted();
        const values = dataTableValuesSchema.parse(JSON.parse(row.valuesText));
        yield table.columns
          .map((column) => escapeCsvValue(values[column.name] ?? null))
          .join(',') + '\r\n';
        after = row.id;
      }
    }
  }
}
