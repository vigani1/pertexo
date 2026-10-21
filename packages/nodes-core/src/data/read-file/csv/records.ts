import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import { parse, CsvError, type Options } from 'csv-parse';
import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import {
  FileInputFailure,
  NodeExecutorFailure,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { convertCsvValue } from '../conversion.js';
import type { CoreReadFileConfig } from '../validation.js';

type CsvConfig = Extract<CoreReadFileConfig, { format: 'csv' }>;
/** Header, column and conversion rules are shared by inline and paged reads. */
export async function* readCsvRecords<T>(
  source: AsyncIterable<Uint8Array>,
  config: CsvConfig,
  signal: AbortSignal,
  options: Readonly<{
    maxRecordSize: number;
    accept(row: Readonly<Record<string, JsonValue>>): T;
  }>,
): AsyncGenerator<T> {
  let headers: readonly string[] | undefined;
  let count = 0;
  let chunkBytes = 1;
  const optionsForParser: Options<T, string[]> & {
    readableHighWaterMark: number;
    writableHighWaterMark: number;
  } = {
    delimiter: config.delimiter,
    record_delimiter: ['\r\n', '\n', '\r'],
    skip_empty_lines: true,
    max_record_size: options.maxRecordSize,
    readableHighWaterMark: 1,
    writableHighWaterMark: 1,
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
        // A short CSV row can expand to long repeated keys. Bound one parse
        // window by header bytes before allowing the producer to read ahead.
        const headerBytes = Buffer.byteLength(JSON.stringify(headers));
        chunkBytes = Math.max(
          1,
          Math.min(4096, Math.floor(32768 / Math.max(1, headerBytes))),
        );
        return null;
      }
      count++;
      if (record.length !== headers.length)
        throw new FileInputFailure({
          reason: 'csv_columns',
          record: count + 1,
          expected: headers.length,
          actual: record.length,
        });
      return options.accept(
        Object.fromEntries(
          headers.map((name, index) => [
            name,
            convertCsvValue(record[index] ?? '', config.convertValues),
          ]),
        ),
      );
    },
  };
  // csv-parse only exposes its changed-output generic for columns:true,
  // although on_record supports the same transformation with header arrays.
  const parser = parse(optionsForParser as unknown as Options);
  async function* decoded() {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let sinceYield = 0;
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.byteLength;) {
        signal.throwIfAborted();
        const part = chunk.subarray(offset, offset + chunkBytes);
        let text: string;
        try {
          text = decoder.decode(part, { stream: true });
        } catch {
          throw new FileInputFailure({ reason: 'invalid_utf8' });
        }
        offset += part.byteLength;
        yield text;
        sinceYield += part.byteLength;
        if (sinceYield >= 65536) {
          await setImmediate(undefined, { signal });
          sinceYield = 0;
        }
      }
    }
    try {
      yield decoder.decode();
    } catch {
      throw new FileInputFailure({ reason: 'invalid_utf8' });
    }
  }
  const input = Readable.from(decoded(), { highWaterMark: 1 });
  // Observe the producer rejection immediately, including while the consumer pauses.
  const pumping = pipeline(input, parser, { signal }).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  try {
    for await (const row of parser as AsyncIterable<T>) yield row;
    const result = await pumping;
    if (result.error !== undefined) {
      if (result.error instanceof Error) throw result.error;
      throw new Error('CSV source failed');
    }
    if (headers === undefined)
      throw new FileInputFailure({ reason: 'csv_empty' });
  } catch (error) {
    if (signal.aborted || error instanceof NodeExecutorFailure) throw error;
    if (
      error instanceof CsvError &&
      error.code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH' &&
      headers !== undefined &&
      Array.isArray(error.record)
    )
      throw new FileInputFailure({
        reason: 'csv_columns',
        record: count + 2,
        expected: headers.length,
        actual: error.record.length,
      });
    if (error instanceof CsvError && error.code === 'CSV_MAX_RECORD_SIZE')
      throw new FileInputFailure({ reason: 'value_size' });
    const line =
      error instanceof CsvError && typeof error.lines === 'number'
        ? error.lines
        : undefined;
    throw new FileInputFailure({
      reason: 'csv_syntax',
      ...(line === undefined ? {} : { line }),
    });
  } finally {
    input.destroy();
    parser.destroy();
    await pumping;
  }
}
