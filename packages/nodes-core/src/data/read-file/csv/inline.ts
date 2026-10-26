import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import type { JsonValue } from '@pertexo/node-sdk/server';
import type { CoreReadFileConfig } from '../validation.js';
import { admitFileRows } from '../admit-value.js';
import { readCsvRecords } from './records.js';

type CsvConfig = Extract<CoreReadFileConfig, { format: 'csv' }>;
export async function parseCsvFile(
  text: string,
  config: CsvConfig,
  signal: AbortSignal,
): Promise<JsonValue> {
  const encoded = Buffer.from(text, 'utf8');
  async function* chunks() {
    for (let offset = 0; offset < encoded.length; offset += 4096) {
      signal.throwIfAborted();
      yield await Promise.resolve(encoded.subarray(offset, offset + 4096));
    }
  }
  try {
    return await admitFileRows(
      readCsvRecords(chunks(), config, signal, {
        maxRecordSize: NODE_JSON_LIMITS.bytes,
        accept: (value) => value,
      }),
    );
  } finally {
    encoded.fill(0);
  }
}
