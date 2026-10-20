import { ARTIFACT_INPUT_MAX_BYTES, escapeCsvValue } from '@pertexo/node-sdk';
import type { JsonValue } from '@pertexo/node-sdk/server';
import { COLLECTION_MAX_ITEMS } from '../lists/semantics/validation.js';
import {
  csvColumnNameSchema,
  type CoreCreateFileConfig,
} from './validation.js';
import { refuseFileCreation } from './failure.js';

type Row = Readonly<Record<string, JsonValue>>;
function csvRows(data: JsonValue): readonly Row[] {
  if (!Array.isArray(data))
    refuseFileCreation(
      'data',
      'CSV needs a list of objects. Map the list to Data.',
    );
  if (data.length > COLLECTION_MAX_ITEMS)
    refuseFileCreation(
      'size',
      `CSV supports up to ${String(COLLECTION_MAX_ITEMS)} rows. Split the data into smaller files.`,
    );
  return data.map((row: JsonValue, index: number) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row))
      refuseFileCreation(
        'data',
        `CSV row ${String(index + 1)} needs an object with named fields.`,
      );
    return row as Row;
  });
}
function csvColumns(
  rows: readonly Row[],
  chosen: readonly string[],
): readonly string[] {
  if (chosen.length > 0) return chosen;
  const columns = new Set<string>();
  for (const row of rows)
    for (const name of Object.keys(row)) {
      if (columns.has(name)) continue;
      if (!csvColumnNameSchema.safeParse(name).success)
        refuseFileCreation(
          'columns',
          'CSV field names must be nonblank and at most 256 characters. Choose columns explicitly or rename the fields.',
        );
      columns.add(name);
      if (columns.size > COLLECTION_MAX_ITEMS)
        refuseFileCreation(
          'columns',
          `Choose up to ${String(COLLECTION_MAX_ITEMS)} CSV columns, in output order.`,
        );
    }
  if (columns.size === 0)
    refuseFileCreation(
      'columns',
      'Choose CSV columns when the rows have no fields.',
    );
  return [...columns];
}
export function encodeFile(
  config: CoreCreateFileConfig,
  data: JsonValue,
  signal: AbortSignal,
): Readonly<{ bytes: Uint8Array; mediaType: string }> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const append = (text: string): void => {
    signal.throwIfAborted();
    byteLength += Buffer.byteLength(text, 'utf8');
    if (byteLength > ARTIFACT_INPUT_MAX_BYTES)
      refuseFileCreation(
        'size',
        'The created file exceeds 1 MB, including its header and quoting. Choose fewer columns or split the data into smaller files.',
      );
    chunks.push(Buffer.from(text, 'utf8'));
  };
  try {
    if (config.format === 'json') append(JSON.stringify(data));
    else if (config.format === 'text') {
      if (typeof data !== 'string')
        refuseFileCreation(
          'data',
          'Text files need text. Map a string to Data, or choose JSON.',
        );
      append(data);
    } else {
      const rows = csvRows(data);
      const columns = csvColumns(rows, config.columns);
      append(columns.map(escapeCsvValue).join(config.delimiter) + '\r\n');
      for (const row of rows)
        append(
          columns
            .map((name) =>
              escapeCsvValue(
                Object.hasOwn(row, name) ? (row[name] ?? null) : null,
              ),
            )
            .join(config.delimiter) + '\r\n',
        );
    }
    return {
      bytes: Buffer.concat(chunks, byteLength),
      mediaType:
        config.format === 'json'
          ? 'application/json'
          : config.format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'text/plain; charset=utf-8',
    };
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
