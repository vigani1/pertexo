import { utf8ByteLength } from '@pertexo/workflow-model';
import { ARTIFACT_INPUT_MAX_BYTES, escapeCsvValue } from '@pertexo/node-sdk';
import type { JsonValue } from '@pertexo/node-sdk/server';
import { COLLECTION_MAX_ITEMS } from '../lists/semantics/validation.js';
import {
  fileColumnNameSchema,
  type CoreCreateFileConfig,
} from './validation.js';
import { refuseFileCreation } from './failure.js';
import { writeWorkbook, XLSX_MEDIA_TYPE } from './xlsx/workbook.js';

type Row = Readonly<Record<string, JsonValue>>;
/** How refusals name the row format: `CSV` or `Excel`. */
export type RowFormat = 'CSV' | 'Excel';

function tableRows(data: JsonValue, format: RowFormat): readonly Row[] {
  if (!Array.isArray(data))
    refuseFileCreation(
      'data',
      `${format} needs a list of objects. Map the list to Data.`,
    );
  if (data.length > COLLECTION_MAX_ITEMS)
    refuseFileCreation(
      'size',
      `${format} supports up to ${String(COLLECTION_MAX_ITEMS)} rows. Split the data into smaller files.`,
    );
  return data.map((row: JsonValue, index: number) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row))
      refuseFileCreation(
        'data',
        `${format} row ${String(index + 1)} needs an object with named fields.`,
      );
    return row as Row;
  });
}
function tableColumns(
  rows: readonly Row[],
  chosen: readonly string[],
  format: RowFormat,
): readonly string[] {
  if (chosen.length > 0) return chosen;
  const columns = new Set<string>();
  for (const row of rows)
    for (const name of Object.keys(row)) {
      if (columns.has(name)) continue;
      if (!fileColumnNameSchema.safeParse(name).success)
        refuseFileCreation(
          'columns',
          `${format} field names must be nonblank and at most 256 characters. Choose columns explicitly or rename the fields.`,
        );
      columns.add(name);
      if (columns.size > COLLECTION_MAX_ITEMS)
        refuseFileCreation(
          'size',
          `Choose up to ${String(COLLECTION_MAX_ITEMS)} ${format} columns, in output order.`,
        );
    }
  if (columns.size === 0)
    refuseFileCreation(
      'columns',
      `Choose ${format} columns when the rows have no fields.`,
    );
  return [...columns];
}
export async function encodeFile(
  config: CoreCreateFileConfig,
  data: JsonValue,
  signal: AbortSignal,
): Promise<Readonly<{ bytes: Uint8Array; mediaType: string }>> {
  if (config.format === 'xlsx') {
    const rows = tableRows(data, 'Excel');
    return {
      bytes: await collectWorkbook(
        writeWorkbook(
          {
            sheetName: config.sheetName,
            columns: tableColumns(rows, config.columns, 'Excel'),
            rows,
          },
          signal,
        ),
      ),
      mediaType: XLSX_MEDIA_TYPE,
    };
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const append = (text: string): void => {
    signal.throwIfAborted();
    byteLength += utf8ByteLength(text);
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
      const rows = tableRows(data, 'CSV');
      const columns = tableColumns(rows, config.columns, 'CSV');
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
      mediaType: FILE_MEDIA_TYPES[config.format],
    };
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function collectWorkbook(
  parts: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of parts) {
      byteLength += chunk.byteLength;
      if (byteLength > ARTIFACT_INPUT_MAX_BYTES)
        refuseFileCreation(
          'size',
          'The created workbook exceeds 1 MB. Choose From pages, fewer columns or split the data into smaller files.',
        );
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, byteLength);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

const FILE_MEDIA_TYPES = {
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  text: 'text/plain; charset=utf-8',
} as const;
