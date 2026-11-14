import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import type { JsonValue } from '@pertexo/node-sdk/server';
import type { CoreReadFileConfig } from '../read-file.schemas.js';
import { admitFileRows } from '../admit-value.js';
import { readCsvRecords } from './csv-records.js';
import { INLINE_CHUNK_BYTES } from '../read-pacing.js';

type CsvConfig = Extract<CoreReadFileConfig, { format: 'csv' }>;
export async function parseCsvFile(
  text: string,
  config: CsvConfig,
  signal: AbortSignal,
): Promise<JsonValue> {
  const encoded = Buffer.from(text, 'utf8');
  async function* chunks() {
    for (
      let offset = 0;
      offset < encoded.length;
      offset += INLINE_CHUNK_BYTES
    ) {
      signal.throwIfAborted();
      yield await Promise.resolve(
        encoded.subarray(offset, offset + INLINE_CHUNK_BYTES),
      );
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
