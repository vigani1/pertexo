import { utf8ByteLength } from '@pertexo/workflow-model';
import { FILE_PAGE_LIMITS, escapeCsvValue } from '@pertexo/node-sdk';
import {
  canonicalizeBoundedJson,
  encodeFilePageRecord,
  type NodeArtifactRuntime,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { refuseFileCreation } from './failure.js';
import type {
  CoreCreateFileConfig,
  CoreCreateFileInput,
} from './validation.js';

/** Read one authorized ordinary page at a time; no array of all records is built. */
async function* records(
  pages: Extract<CoreCreateFileInput, { pages: unknown }>['pages'],
  artifacts: NodeArtifactRuntime,
  signal: AbortSignal,
): AsyncGenerator<JsonValue> {
  let bytes = 0,
    count = 0;
  if (artifacts.read === undefined)
    refuseFileCreation(
      'storage',
      'File reading is unavailable. Ask the instance owner to configure it.',
    );
  for (const { kind: _kind, ...reference } of pages) {
    signal.throwIfAborted();
    bytes += reference.byteLength;
    if (bytes > FILE_PAGE_LIMITS.totalBytes)
      refuseFileCreation(
        'size',
        'The input pages exceed 10 MB. Split the data into smaller files.',
      );
    const input = await artifacts.read({
      reference,
      maxBytes: FILE_PAGE_LIMITS.bytes,
      signal,
    });
    try {
      let value: JsonValue;
      try {
        value = canonicalizeBoundedJson(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)),
          {
            bytes: FILE_PAGE_LIMITS.bytes,
            depth: FILE_PAGE_LIMITS.depth,
            members: FILE_PAGE_LIMITS.members,
          },
        );
      } catch {
        refuseFileCreation(
          'data',
          'A page is malformed or exceeds the 64 KB page limits. Read the source with Output pages again.',
        );
      }
      if (!Array.isArray(value) || value.length > FILE_PAGE_LIMITS.items)
        refuseFileCreation(
          'data',
          'Each page must be a JSON list of at most 1,000 records. Read the source with Output pages again.',
        );
      for (const record of value as readonly JsonValue[]) {
        if (++count > FILE_PAGE_LIMITS.totalItems)
          refuseFileCreation(
            'size',
            'The pages exceed 100,000 records. Split the data into smaller files.',
          );
        encodeFilePageRecord(record);
        yield record;
      }
    } finally {
      input.fill(0);
    }
  }
}
export function createFileFromPages(
  config: CoreCreateFileConfig,
  input: CoreCreateFileInput,
  artifacts: NodeArtifactRuntime,
  signal: AbortSignal,
) {
  if (config.format === 'text' || !('pages' in input))
    refuseFileCreation(
      'data',
      'Map the ordered page references to Pages and choose JSON or CSV.',
    );
  if (config.format === 'csv' && config.columns.length === 0)
    refuseFileCreation(
      'columns',
      'Choose CSV columns explicitly, in output order, when creating a file from pages.',
    );
  const pages = input.pages;
  const selected = config;
  async function* body() {
    let size = 0,
      first = true;
    async function* append(text: string) {
      signal.throwIfAborted();
      size += utf8ByteLength(text);
      if (size > FILE_PAGE_LIMITS.fileBytes)
        refuseFileCreation(
          'size',
          'The created file exceeds 10 MB, including headers and quoting. Choose fewer columns or split the data into smaller files.',
        );
      const bytes = Buffer.from(text, 'utf8');
      try {
        yield await Promise.resolve(bytes);
      } finally {
        bytes.fill(0);
      }
    }
    if (selected.format === 'json') yield* append('[');
    else
      yield* append(
        selected.columns.map(escapeCsvValue).join(selected.delimiter) + '\r\n',
      );
    for await (const record of records(pages, artifacts, signal)) {
      if (selected.format === 'json')
        yield* append((first ? '' : ',') + JSON.stringify(record));
      else {
        if (
          record === null ||
          typeof record !== 'object' ||
          Array.isArray(record)
        )
          refuseFileCreation(
            'data',
            'CSV pages need object rows with named fields. Choose JSON for other values.',
          );
        const row = record as Readonly<Record<string, JsonValue>>;
        yield* append(
          selected.columns
            .map((name) =>
              escapeCsvValue(
                Object.hasOwn(row, name) ? (row[name] ?? null) : null,
              ),
            )
            .join(selected.delimiter) + '\r\n',
        );
      }
      first = false;
    }
    if (selected.format === 'json') yield* append(']');
  }
  return artifacts.write({
    body: body(),
    maxBytes: FILE_PAGE_LIMITS.fileBytes,
    mediaType:
      config.format === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
    purpose: 'node-output',
    signal,
  });
}
