import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  NodeArtifactRuntime,
  NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import { FileInputFailure } from '@pertexo/node-sdk/server';

export function verifiedSource(bytes: Uint8Array): NodeVerifiedByteSource {
  let released = false;
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    open(signal) {
      if (released) throw new Error('Released test source');
      return Readable.from(
        (async function* () {
          for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
            signal.throwIfAborted();
            yield bytes.slice(offset, offset + 65536);
          }
          await Promise.resolve();
        })(),
        { objectMode: false, highWaterMark: 65536 },
      );
    },
    release() {
      released = true;
      bytes.fill(0);
      return Promise.resolve();
    },
  };
}
export const spoolBytes: NonNullable<NodeArtifactRuntime['spool']> = async ({
  body,
  signal,
  maxBytes,
}) => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      signal.throwIfAborted();
      length += chunk.byteLength;
      if (length > maxBytes)
        throw new FileInputFailure({ reason: 'multipart_size' });
      chunks.push(Uint8Array.from(chunk));
      chunk.fill(0);
    }
    return verifiedSource(Buffer.concat(chunks, length));
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
  }
};
export const emptyArtifactRuntime: NodeArtifactRuntime = {
  spool: spoolBytes,
  write: () => Promise.reject(new Error('No artifact writes expected')),
};
export async function sourceBytes(
  body: Uint8Array | NodeVerifiedByteSource,
): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Uint8Array[] = [];
  for await (const value of body.open(new AbortController().signal)) {
    const chunk: unknown = value;
    if (!(chunk instanceof Uint8Array))
      throw new Error('Expected native bytes');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function inlineBytes(
  body: Uint8Array | NodeVerifiedByteSource,
): Uint8Array;
export function inlineBytes(
  body: Uint8Array | NodeVerifiedByteSource | undefined,
): Uint8Array | undefined;
export function inlineBytes(
  body: Uint8Array | NodeVerifiedByteSource | undefined,
): Uint8Array | undefined {
  if (body !== undefined && !(body instanceof Uint8Array))
    throw new Error('Expected an inline provider body');
  return body;
}
