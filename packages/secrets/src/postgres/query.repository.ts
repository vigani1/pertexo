import pg from 'pg';
import { POSTGRES_LIMITS, type PostgresResult } from '@pertexo/contracts';
import type { ResponseRedactor } from '../outbound-http/redaction/response-redactor.js';
import { prepareResponseRedactor } from '../outbound-http/redaction/response-redactor.js';
import { PostgresError } from './postgres.errors.js';

const POSTGRES_WIRE_OVERHEAD_FACTOR = 4;

export function createPostgresResultReader(
  client: pg.Client,
  maxRows: number,
  sensitiveValues: readonly string[],
) {
  const redactor = prepareResponseRedactor(
    sensitiveValues,
    POSTGRES_LIMITS.resultBytes,
  );
  const budget = {
    rows: maxRows,
    bytes: POSTGRES_LIMITS.resultBytes,
    wireBytes: POSTGRES_LIMITS.resultBytes * POSTGRES_WIRE_OVERHEAD_FACTOR,
  };
  return (text: string, values: readonly unknown[] = []) =>
    queryPostgres(client, { text, values }, budget, redactor);
}

function queryPostgres(
  client: pg.Client,
  { text, values }: Readonly<{ text: string; values: readonly unknown[] }>,
  budget: { rows: number; bytes: number; wireBytes: number },
  redactor: ResponseRedactor,
): Promise<PostgresResult> {
  // Extended protocol accepts one statement and binds parameters even for a
  // query with an empty parameter list. A row listener avoids pg buffering.
  const config = {
    text,
    values: [...values],
    queryMode: 'extended',
    rows: budget.rows + 1,
  };
  const query = new pg.Query<Record<string, unknown>, unknown[]>(config);
  const rows: Record<string, unknown>[] = [];
  let failed = false;
  // The wire budget bounds a single row before pg finishes parsing it.
  const stream = client.connection.stream;
  return new Promise<PostgresResult>((resolve, reject) => {
    const refuse = (error: Error) => {
      if (failed) return;
      failed = true;
      reject(error);
      stream.destroy();
    };
    const countBytes = (chunk: Buffer) => {
      budget.wireBytes -= chunk.byteLength;
      if (budget.wireBytes < 0) refuse(new PostgresError('result_limit'));
    };
    const detach = () => stream.off('data', countBytes);
    query.on('error', (error) => {
      detach();
      reject(error);
    });
    query.on('end', (result) => {
      detach();
      resolve({ rows, rowCount: result.rowCount ?? rows.length });
    });
    stream.prependListener('data', countBytes);
    query.on('row', (row) => {
      if (failed) return;
      try {
        if (budget.rows === 0) throw new PostgresError('row_limit');
        const raw = JSON.stringify(row);
        if (Buffer.byteLength(raw) > budget.bytes)
          throw new PostgresError('result_limit');
        const clean = JSON.parse(raw, (_key, value: unknown) => {
          if (typeof value === 'string') return redactor.text(value);
          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value)
          )
            return value;
          return Object.fromEntries(
            Object.entries(value).map(([name, entry]) => [
              redactor.text(name),
              entry,
            ]),
          );
        }) as Record<string, unknown>;
        budget.bytes -=
          Math.max(
            Buffer.byteLength(raw),
            Buffer.byteLength(JSON.stringify(clean)),
          ) + 1;
        if (budget.bytes < 0) throw new PostgresError('result_limit');
        budget.rows -= 1;
        rows.push(clean);
      } catch (error) {
        detach();
        refuse(
          error instanceof PostgresError
            ? error
            : new PostgresError('result_limit'),
        );
      }
    });
    client.query(query);
  });
}

export async function requirePostgresColumns(
  client: pg.Client,
  schema: string,
  table: string,
  columns: readonly string[],
): Promise<void> {
  const result = await client.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and column_name = any($3::text[])`,
    [schema, table, columns],
  );
  if (result.rowCount !== columns.length)
    throw new PostgresError('invalid_columns');
}
