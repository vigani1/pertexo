import { TextDecoder } from 'node:util';
import { SECURE_HTTP_ERROR_CODE, failure } from './secure-error.js';

export function responseCharset(contentType: string): string | undefined {
  return /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu
    .exec(contentType)
    ?.slice(1)
    .find(Boolean);
}

/** Decode before masking; a declared charset never falls back to unscanned bytes. */
export async function* decodedResponseChunks(
  chunks: AsyncIterable<Uint8Array>,
  charset: string | undefined,
): AsyncGenerator<Uint8Array> {
  let decoder: TextDecoder | undefined;
  let first = true;
  try {
    for await (const chunk of chunks) {
      try {
        if (first) {
          first = false;
          decoder = createDecoder(charset, chunk);
        }
        yield decoder === undefined
          ? Buffer.from(chunk)
          : Buffer.from(decoder.decode(chunk, { stream: true }));
      } finally {
        chunk.fill(0);
      }
    }
    if (decoder !== undefined) yield Buffer.from(decoder.decode());
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw failure(SECURE_HTTP_ERROR_CODE.responseEncodingRejected, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    throw error;
  }
}

function createDecoder(
  charset: string | undefined,
  first: Uint8Array,
): TextDecoder | undefined {
  let encoding = charset;
  if (encoding === undefined && first[0] === 255 && first[1] === 254)
    encoding = 'utf-16le';
  if (encoding === undefined && first[0] === 254 && first[1] === 255)
    encoding = 'utf-16be';
  return encoding === undefined
    ? undefined
    : new TextDecoder(encoding, { fatal: true });
}
