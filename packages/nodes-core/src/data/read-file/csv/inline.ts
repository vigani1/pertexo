import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse, CsvError } from 'csv-parse';
import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import { FileInputFailure, type JsonValue } from '@pertexo/node-sdk/server';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';
import { convertCsvValue } from '../conversion.js';
import type { CoreReadFileConfig } from '../validation.js';
import { admitFileValue } from '../admit-value.js';

type CsvConfig = Extract<CoreReadFileConfig, { format: 'csv' }>;
export async function parseCsvFile(
  text: string,
  config: CsvConfig,
  signal: AbortSignal,
): Promise<JsonValue> {
  let headers: readonly string[] | undefined;
  let count = 0;
  let members = 0;
  let bytes = 2;
  const rows: JsonValue[] = [];
  const parser = parse({
    delimiter: config.delimiter,
    record_delimiter: ['\r\n', '\n', '\r'],
    skip_empty_lines: true,
    max_record_size: NODE_JSON_LIMITS.bytes,
    on_record: (record: string[]) => {
      signal.throwIfAborted();
      if (headers === undefined) {
        if (record.length > NODE_JSON_LIMITS.members)
          throw new FileInputFailure({ reason: 'value_size' });
        const unique = new Set<string>();
        for (const [index, name] of record.entries()) {
          if (name.trim() === '')
            throw new FileInputFailure({
              reason: 'csv_blank_header',
              column: index + 1,
            });
          if (unique.has(name))
            throw new FileInputFailure({
              reason: 'csv_duplicate_header',
              column: index + 1,
            });
          unique.add(name);
        }
        headers = record;
        return null;
      }
      count++;
      if (count > COLLECTION_MAX_ITEMS)
        throw new FileInputFailure({ reason: 'item_count' });
      if (record.length !== headers.length)
        throw new FileInputFailure({
          reason: 'csv_columns',
          record: count + 1,
          expected: headers.length,
          actual: record.length,
        });
      members += 1 + record.length;
      if (members > NODE_JSON_LIMITS.members)
        throw new FileInputFailure({ reason: 'value_size' });
      const row = Object.fromEntries(
        headers.map((name, index) => [
          name,
          convertCsvValue(record[index] ?? '', config.convertValues),
        ]),
      );
      bytes += Buffer.byteLength(JSON.stringify(row)) + (count > 1 ? 1 : 0);
      if (bytes > NODE_JSON_LIMITS.bytes)
        throw new FileInputFailure({ reason: 'value_size' });
      rows.push(row);
      return null;
    },
  });
  const encoded = Buffer.from(text, 'utf8');
  function* chunks() {
    for (let offset = 0; offset < encoded.length; offset += 4096) {
      signal.throwIfAborted();
      yield encoded.subarray(offset, offset + 4096);
    }
  }
  try {
    await pipeline(
      Readable.from(chunks()),
      parser,
      async (source: AsyncIterable<unknown>) => {
        for await (const _row of source) {
          signal.throwIfAborted();
        }
      },
      { signal },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof FileInputFailure) throw error;
    if (
      error instanceof CsvError &&
      error.code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH'
    ) {
      const expected = headers?.length;
      const actual =
        typeof error.record === 'object' && Array.isArray(error.record)
          ? error.record.length
          : undefined;
      if (expected !== undefined && actual !== undefined)
        throw new FileInputFailure({
          reason: 'csv_columns',
          record: count + 2,
          expected,
          actual,
        });
    }
    const line =
      error instanceof CsvError && typeof error.lines === 'number'
        ? error.lines
        : undefined;
    throw new FileInputFailure({
      reason: 'csv_syntax',
      ...(line === undefined ? {} : { line }),
    });
  } finally {
    encoded.fill(0);
  }
  if (headers === undefined)
    throw new FileInputFailure({ reason: 'csv_empty' });
  return admitFileValue(rows);
}
