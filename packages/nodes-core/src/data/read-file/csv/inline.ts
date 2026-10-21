import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import { FileInputFailure, type JsonValue } from '@pertexo/node-sdk/server';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';
import type { CoreReadFileConfig } from '../validation.js';
import { admitFileValue } from '../admit-value.js';
import { readCsvRecords } from './records.js';

type CsvConfig = Extract<CoreReadFileConfig, { format: 'csv' }>;
export async function parseCsvFile(
  text: string,
  config: CsvConfig,
  signal: AbortSignal,
): Promise<JsonValue> {
  const encoded = Buffer.from(text, 'utf8');
  const rows: JsonValue[] = [];
  let members = 0,
    bytes = 2;
  async function* chunks() {
    for (let offset = 0; offset < encoded.length; offset += 4096) {
      signal.throwIfAborted();
      yield await Promise.resolve(encoded.subarray(offset, offset + 4096));
    }
  }
  try {
    for await (const row of readCsvRecords(chunks(), config, signal, {
      maxRecordSize: NODE_JSON_LIMITS.bytes,
      accept: (value) => value,
    })) {
      if (rows.length >= COLLECTION_MAX_ITEMS)
        throw new FileInputFailure({ reason: 'item_count' });
      members += 1 + Object.keys(row).length;
      if (members > NODE_JSON_LIMITS.members)
        throw new FileInputFailure({ reason: 'value_size' });
      bytes +=
        Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
      if (bytes > NODE_JSON_LIMITS.bytes)
        throw new FileInputFailure({ reason: 'value_size' });
      rows.push(row);
    }
    return admitFileValue(rows);
  } finally {
    encoded.fill(0);
  }
}
