import { TextDecoder } from 'node:util';
import { SECURE_HTTP_ERROR_CODE, failure } from './secure-error.js';

export function responseCharset(contentType: string): string | undefined {
  let charset: string | undefined;
  for (const parameter of contentTypeParameters(contentType)) {
    if (!/^charset(?:\s|=|$)/iu.test(parameter)) continue;
    const matched =
      /^charset\s*=\s*(?:"([^"\\]*)"|([!#$%&'*+.^_`|~a-z0-9-]+))\s*$/iu.exec(
        parameter,
      );
    const label = (matched?.[1] ?? matched?.[2] ?? '').trim();
    if (label.length === 0 || charset !== undefined)
      throw failure(SECURE_HTTP_ERROR_CODE.responseEncodingRejected, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    // Validate before invoking a body consumer, including for an empty body.
    charset = requireDecodableText(
      () => new TextDecoder(label, { fatal: true }),
    ).encoding;
  }
  return charset;
}

/** Decode before masking; a declared charset never falls back to unscanned bytes. */
export async function* decodedResponseChunks(
  chunks: AsyncIterable<Uint8Array>,
  charset: string | undefined,
): AsyncGenerator<Uint8Array> {
  let decoder: TextDecoder | undefined;
  let first = true;
  for await (const chunk of chunks) {
    try {
      if (first) {
        first = false;
        decoder = requireDecodableText(() => createDecoder(charset, chunk));
      }
      const current = decoder;
      yield current === undefined
        ? Buffer.from(chunk)
        : Buffer.from(
            requireDecodableText(() => current.decode(chunk, { stream: true })),
          );
    } finally {
      chunk.fill(0);
    }
  }
  if (decoder !== undefined)
    yield Buffer.from(requireDecodableText(() => decoder.decode()));
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

/** Only codec refusals belong here; a source failure remains a transport failure. */
function requireDecodableText<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw failure(SECURE_HTTP_ERROR_CODE.responseEncodingRejected, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    throw error;
  }
}

function contentTypeParameters(contentType: string): readonly string[] {
  const parameters: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < contentType.length; index += 1) {
    const character = contentType[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character !== ';' || quoted) continue;
    parameters.push(contentType.slice(start, index).trim());
    start = index + 1;
  }
  parameters.push(contentType.slice(start).trim());
  return parameters.slice(1);
}
