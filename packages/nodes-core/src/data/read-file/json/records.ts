import { setImmediate } from 'node:timers/promises';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';
import {
  FILE_PAGE_LIMITS,
  StoredExecutionValueInvalidError,
  storedExecutionJsonStringBytes,
} from '@pertexo/node-sdk';
import {
  encodeFilePageRecord,
  NodeExecutorFailure,
  type EncodedFilePageRecord,
  FileInputFailure,
  InvalidBoundedJsonError,
} from '@pertexo/node-sdk/server';

const INPUT_CHUNK_BYTES = 1_024;
const YIELD_BYTES = 65_536;

function tooLarge(): never {
  throw new FileInputFailure({ reason: 'page_value_size' });
}

/** Token callbacks enforce allocation bounds before the library builds a record. */
function createParser(
  accept: (value: EncodedFilePageRecord) => void,
): Readonly<{
  write(chunk: Uint8Array): void;
  end(): void;
}> {
  const tokenizer = new Tokenizer({
    emitPartialTokens: true,
    stringBufferSize: INPUT_CHUNK_BYTES,
    numberBufferSize: INPUT_CHUNK_BYTES,
  });
  const parser = new TokenParser({ paths: ['$.*'], keepStack: false });
  const containers: TokenType[] = [];
  let started = false;
  let previous: TokenType | undefined;
  let bytes = 0;
  let rawTokenBytes = 0;
  let encodedBytes = 0;
  let members = 1;
  let items = 0;

  tokenizer.onToken = (info): void => {
    if (info.partial) {
      // Partial Unicode escapes may end on a high surrogate: validate text only
      // once the full token arrives. Length still bounds the pending allocation.
      if (
        typeof info.value === 'string' &&
        info.value.length > FILE_PAGE_LIMITS.bytes
      )
        tooLarge();
      return;
    }
    rawTokenBytes = 0;
    const token = info.token;
    if (!started) {
      if (token !== TokenType.LEFT_BRACKET)
        throw new FileInputFailure({ reason: 'page_array' });
      started = true;
    }
    const insideRecord = tokenIsInsideRecord(containers, token);
    if (insideRecord) {
      encodedBytes += tokenJsonBytes(token, info.value);
      if (encodedBytes > FILE_PAGE_LIMITS.bytes - 2) tooLarge();
    }
    const addsMember = tokenAddsMember(containers, token, previous);
    if (addsMember) {
      members += 1;
      if (members > FILE_PAGE_LIMITS.members) tooLarge();
    }
    if (token === TokenType.LEFT_BRACKET || token === TokenType.LEFT_BRACE) {
      if (containers.length >= FILE_PAGE_LIMITS.depth) tooLarge();
      containers.push(token);
    } else if (
      token === TokenType.RIGHT_BRACKET ||
      token === TokenType.RIGHT_BRACE
    )
      containers.pop();
    previous = token;
    parser.write(info);
  };
  parser.onValue = ({ value }): void => {
    items += 1;
    if (items > FILE_PAGE_LIMITS.totalItems)
      throw new FileInputFailure({ reason: 'page_item_count' });
    try {
      accept(encodeFilePageRecord(value));
    } catch {
      tooLarge();
    }
    encodedBytes = 0;
    members = 1;
  };
  tokenizer.onEnd = (): void => {
    if (!parser.isEnded) parser.end();
  };
  // Never let parser diagnostics include file contents in a failure summary.
  parser.onError = tokenizer.onError = (error: Error): never => {
    if (error instanceof NodeExecutorFailure) throw error;
    if (
      error instanceof StoredExecutionValueInvalidError ||
      error instanceof InvalidBoundedJsonError
    )
      tooLarge();
    throw new FileInputFailure({ reason: 'json_syntax' });
  };
  return {
    write: (chunk): void => {
      bytes += chunk.byteLength;
      if (bytes > FILE_PAGE_LIMITS.fileBytes)
        throw new FileInputFailure({ reason: 'file_size' });
      // Some incomplete number states emit no partial token; others swallow
      // callback errors. This independent raw-token bound covers both cases.
      // Whitespace between tokens consumes no parser allocation. String
      // whitespace remains covered by the decoded partial-string bound above.
      for (const byte of chunk) {
        const significantByte =
          byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
        if (significantByte) rawTokenBytes += 1;
      }
      if (rawTokenBytes > 6 * FILE_PAGE_LIMITS.bytes + INPUT_CHUNK_BYTES)
        tooLarge();
      tokenizer.write(chunk);
    },
    end: (): void => {
      if (!started) throw new FileInputFailure({ reason: 'json_syntax' });
      if (!tokenizer.isEnded) tokenizer.end();
      if (!parser.isEnded) parser.end();
    },
  };
}

/** Consume a verified file; backpressure retains only a bounded parser window. */
export async function* readJsonRecords(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<EncodedFilePageRecord> {
  let pending: EncodedFilePageRecord[] = [];
  const parser = createParser((value) => pending.push(value));
  let sinceYield = 0;
  for await (const chunk of source) {
    for (
      let offset = 0;
      offset < chunk.byteLength;
      offset += INPUT_CHUNK_BYTES
    ) {
      signal.throwIfAborted();
      const part = chunk.subarray(offset, offset + INPUT_CHUNK_BYTES);
      parser.write(part);
      const ready = pending;
      pending = [];
      yield* ready;
      sinceYield += part.byteLength;
      if (sinceYield >= YIELD_BYTES) {
        await setImmediate(undefined, { signal });
        sinceYield = 0;
      }
    }
  }
  signal.throwIfAborted();
  parser.end();
  yield* pending;
}

function tokenJsonBytes(token: TokenType, value: unknown): number {
  switch (token) {
    case TokenType.STRING:
      return storedExecutionJsonStringBytes(value as string);
    case TokenType.NUMBER:
      if (!Number.isFinite(value))
        throw new FileInputFailure({ reason: 'json_number' });
      return JSON.stringify(value).length;
    case TokenType.NULL:
    case TokenType.TRUE:
      return 4;
    case TokenType.FALSE:
      return 5;
    case TokenType.COLON:
    case TokenType.COMMA:
    case TokenType.LEFT_BRACE:
    case TokenType.LEFT_BRACKET:
    case TokenType.RIGHT_BRACE:
    case TokenType.RIGHT_BRACKET:
    case TokenType.SEPARATOR:
      // Container and separator punctuation each occupies one byte.
      return 1;
    default:
      return 1;
  }
}

function tokenIsInsideRecord(
  containers: readonly TokenType[],
  token: TokenType,
): boolean {
  return (
    containers.length > 1 ||
    (containers.length === 1 &&
      token !== TokenType.COMMA &&
      token !== TokenType.RIGHT_BRACKET)
  );
}

function tokenAddsMember(
  containers: readonly TokenType[],
  token: TokenType,
  previous: TokenType | undefined,
): boolean {
  return (
    token === TokenType.COLON ||
    (containers.length > 1 &&
      containers.at(-1) === TokenType.LEFT_BRACKET &&
      token !== TokenType.COMMA &&
      token !== TokenType.RIGHT_BRACKET &&
      (previous === TokenType.LEFT_BRACKET || previous === TokenType.COMMA))
  );
}
