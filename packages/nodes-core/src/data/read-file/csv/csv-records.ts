import { utf8ByteLength } from '@pertexo/workflow-model';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import { parse, CsvError, type Options } from 'csv-parse';
import { FileInputFailure, type JsonValue } from '@pertexo/node-sdk/server';
import { convertCsvValue } from '../conversion.js';
import { admitHeaders } from '../headers.js';
import type { CoreReadFileConfig } from '../read-file.schemas.js';
import { READ_YIELD_BYTES } from '../read-pacing.js';

// One parse window holds at most this many source bytes, and at most the
// header budget divided by the header's size, since short rows repeat its keys.
const CSV_PARSE_WINDOW = Object.freeze({
  maxChunkBytes: 4_096,
  headerBudgetBytes: 32_768,
});
// The header is line 1, so record N is line N + 1, counted from 1.
const CSV_FIRST_RECORD_LINE = 2;

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
        headers = admitHeaders(record);
        // A short CSV row can expand to long repeated keys. Bound one parse
        // window by header bytes before allowing the producer to read ahead.
        const headerBytes = utf8ByteLength(JSON.stringify(headers));
        chunkBytes = Math.max(
          1,
          Math.min(
            CSV_PARSE_WINDOW.maxChunkBytes,
            Math.floor(
              CSV_PARSE_WINDOW.headerBudgetBytes / Math.max(1, headerBytes),
            ),
          ),
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
            convertCsvValue(record[index] ?? '', {
              enabled: config.convertValues,
            }),
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
        if (sinceYield >= READ_YIELD_BYTES) {
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
    // Only the parser's own errors describe the file's contents; a failed
    // read of the stored file passes through unchanged, as in the JSON reader.
    if (signal.aborted || !(error instanceof CsvError)) throw error;
    const mismatch = columnMismatch(error, headers);
    if (mismatch !== undefined)
      throw new FileInputFailure({
        reason: 'csv_columns',
        // Records count from 1, after the header line.
        record: count + CSV_FIRST_RECORD_LINE,
        ...mismatch,
      });
    if (error.code === 'CSV_MAX_RECORD_SIZE')
      throw new FileInputFailure({ reason: 'value_size' });
    const line = typeof error.lines === 'number' ? error.lines : undefined;
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

function columnMismatch(
  error: CsvError,
  headers: readonly string[] | undefined,
) {
  if (
    error.code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH' &&
    headers !== undefined &&
    Array.isArray(error.record)
  )
    return { expected: headers.length, actual: error.record.length };
  return undefined;
}
