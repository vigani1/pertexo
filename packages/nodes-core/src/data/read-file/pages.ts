import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import {
  encodeFilePageRecord,
  FileInputFailure,
  writeFilePages,
  type NodeArtifactReference,
  type NodeArtifactRuntime,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { readCsvRecords } from './csv/records.js';
import { readJsonRecords } from './json/records.js';
import type { CoreReadFileConfig } from './validation.js';

export async function readFilePages(
  reference: NodeArtifactReference,
  config: CoreReadFileConfig,
  artifacts: NodeArtifactRuntime | undefined,
  signal: AbortSignal,
): Promise<JsonValue> {
  if (reference.byteLength > FILE_PAGE_LIMITS.fileBytes)
    throw new FileInputFailure({ reason: 'file_size' });
  if (artifacts?.openVerified === undefined)
    throw new FileInputFailure({ reason: 'file_unavailable' });
  const source = await artifacts.openVerified({
    reference,
    maxBytes: FILE_PAGE_LIMITS.fileBytes,
    signal,
  });
  async function* chunks() {
    const body = source.open(signal);
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        try {
          yield chunk;
        } finally {
          chunk.fill(0);
        }
      }
    } finally {
      body.destroy();
    }
  }
  try {
    const records =
      config.format === 'json'
        ? readJsonRecords(chunks(), signal)
        : readCsvRecords(chunks(), config, signal, {
            maxRecordSize: FILE_PAGE_LIMITS.bytes,
            accept: encodeFilePageRecord,
          });
    return await writeFilePages(records, artifacts, signal);
  } finally {
    await source.release();
  }
}
