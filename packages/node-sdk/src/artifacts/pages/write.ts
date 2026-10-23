import type { NodeArtifactRuntime } from '../../execution/contract.js';
import { STORED_EXECUTION_VALUE_LIMITS } from '../../values/stored-json.js';
import { FILE_PAGE_LIMITS } from '../page-limits.js';
import type { FilePageBundle } from './bundle.js';
import type { EncodedFilePageRecord } from './encode-record.js';
import { refuseFilePages } from './failure.js';

/** Only a page under construction and immutable file references survive backpressure. */
export async function writeFilePages(
  records: AsyncIterable<EncodedFilePageRecord>,
  artifacts: Pick<NodeArtifactRuntime, 'write'> | undefined,
  signal: AbortSignal,
): Promise<FilePageBundle> {
  if (artifacts === undefined) refuseFilePages('storage');
  const storage = artifacts;
  const pages: FilePageBundle['pages'][number][] = [];
  let pending: string[] = [];
  let pendingBytes = 2,
    pendingMembers = 0,
    storedBytes = 0,
    itemCount = 0;
  const bundle = (): FilePageBundle =>
    Object.freeze({
      pages: Object.freeze([...pages]),
      itemCount,
      pageCount: pages.length,
    });
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    if (pages.length >= FILE_PAGE_LIMITS.pages) refuseFilePages('pages');
    if (storedBytes + pendingBytes > FILE_PAGE_LIMITS.totalBytes)
      refuseFilePages('bytes');
    const bytes = Buffer.from('[' + pending.join(',') + ']', 'utf8');
    try {
      const reference = await storage.write({
        body: (async function* () {
          yield await Promise.resolve(bytes);
        })(),
        maxBytes: bytes.byteLength,
        mediaType: 'application/json',
        purpose: 'node-output',
        signal,
      });
      signal.throwIfAborted();
      pages.push(Object.freeze({ kind: 'artifact', ...reference }));
      storedBytes += pendingBytes;
      if (
        Buffer.byteLength(JSON.stringify(bundle()), 'utf8') >
        STORED_EXECUTION_VALUE_LIMITS.inlineBytes
      )
        refuseFilePages('descriptor');
    } finally {
      bytes.fill(0);
    }
    pending = [];
    pendingBytes = 2;
    pendingMembers = 0;
  };
  for await (const record of records) {
    signal.throwIfAborted();
    if (itemCount >= FILE_PAGE_LIMITS.totalItems) refuseFilePages('items');
    const separator = pending.length > 0 ? 1 : 0;
    const pageWouldOverflow =
      pending.length > 0 &&
      (pending.length >= FILE_PAGE_LIMITS.items ||
        pendingBytes + record.bytes + separator > FILE_PAGE_LIMITS.bytes ||
        pendingMembers + record.members > FILE_PAGE_LIMITS.members);
    if (pageWouldOverflow) await flush();
    const addition = record.bytes + (pending.length > 0 ? 1 : 0);
    if (storedBytes + pendingBytes + addition > FILE_PAGE_LIMITS.totalBytes)
      refuseFilePages('bytes');
    pending.push(record.json);
    pendingBytes += addition;
    pendingMembers += record.members;
    itemCount++;
  }
  signal.throwIfAborted();
  await flush();
  return bundle();
}
