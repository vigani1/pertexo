import { decodedResponseChunks } from './response-charset.js';
import {
  prepareResponseRedactor,
  type ResponseRedactor,
} from './response-redactor.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  SECURE_HTTP_ERROR_CODE,
  type SecureHttpError,
  failure,
  abortFailure,
  inspectSecureHttpError,
  isTimeoutError,
} from './secure-error.js';

const BODY_CHUNK_BYTES = 65_536;

export async function* boundedRedactedBody(
  body: AsyncIterable<Uint8Array>,
  {
    limit,
    signal,
    sensitiveValues,
    deadline,
    redactor = prepareResponseRedactor(sensitiveValues, limit),
    charset,
  }: Readonly<{
    limit: number;
    signal: AbortSignal;
    sensitiveValues: readonly string[];
    deadline: number;
    redactor?: ResponseRedactor;
    charset?: string;
  }>,
): AsyncGenerator<Uint8Array> {
  let emittedBytes = 0;
  let pending: Uint8Array = new Uint8Array();
  let covered = 0;
  const emit = (value: Uint8Array): Uint8Array | undefined => {
    if (value.byteLength === 0) return undefined;
    emittedBytes += value.byteLength;
    assertBodyByteLimit(emittedBytes, limit);
    return value;
  };
  try {
    const raw = boundedSourceChunks(body, limit, signal);
    const decoded = decodedResponseChunks(raw, charset);
    for await (const chunk of boundedSourceChunks(decoded, limit, signal)) {
      if (signal.aborted)
        throw abortFailure(signal, {
          possiblyDispatched: true,
          ambiguous: false,
        });
      const previous = pending;
      try {
        pending = Buffer.concat([previous, chunk]);
      } finally {
        previous.fill(0);
      }
      // Yield even for buffered iterators so cancellation/deadline timers progress.
      await yieldToEventLoop();
      assertBodyDeadline(signal, deadline);
      const redacted = redactor.redact(
        Buffer.from(pending.buffer, pending.byteOffset, pending.byteLength),
        { covered, final: false },
      );
      pending.fill(0);
      pending = redacted.remaining;
      covered = redacted.covered;
      const output = emit(redacted.emitted);
      if (output !== undefined) yield output;
    }
    const candidate = pending;
    assertBodyDeadline(signal, deadline);
    const redacted = redactor.redact(
      Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength),
      { covered, final: true },
    );
    candidate.fill(0);
    pending = redacted.remaining;
    const output = emit(redacted.emitted);
    if (output !== undefined) yield output;
  } catch (error: unknown) {
    const secureError = inspectSecureHttpError(error);
    if (secureError !== undefined) throw secureError.error;
    throw mapResponseStreamError(error, signal);
  } finally {
    pending.fill(0);
  }
}

function assertBodyDeadline(signal: AbortSignal, deadline: number): void {
  if (signal.aborted)
    throw abortFailure(signal, { possiblyDispatched: true, ambiguous: true });
  if (performance.now() >= deadline)
    throw failure(SECURE_HTTP_ERROR_CODE.timedOut, {
      possiblyDispatched: true,
      ambiguous: true,
    });
}

function mapResponseStreamError(
  error: unknown,
  signal: AbortSignal | undefined,
): SecureHttpError {
  if (signal?.aborted)
    return abortFailure(signal, { possiblyDispatched: true, ambiguous: true });
  if (isTimeoutError(error))
    return failure(SECURE_HTTP_ERROR_CODE.timedOut, {
      possiblyDispatched: true,
      ambiguous: true,
      cause: error,
    });
  return failure(SECURE_HTTP_ERROR_CODE.networkFailed, {
    possiblyDispatched: true,
    ambiguous: true,
    cause: error,
  });
}

/** Bound decoding work per turn while retaining ownership of every source chunk. */
async function* boundedSourceChunks(
  body: AsyncIterable<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let buffer = Buffer.alloc(BODY_CHUNK_BYTES);
  let length = 0;
  let chunks = 0;
  try {
    for await (const chunk of ownedSourceChunks(body, limit, signal)) {
      if (++chunks % 4096 === 0) await yieldToEventLoop();
      let offset = 0;
      while (offset < chunk.byteLength) {
        const size = Math.min(
          chunk.byteLength - offset,
          buffer.length - length,
        );
        buffer.set(chunk.subarray(offset, offset + size), length);
        length += size;
        offset += size;
        if (length < buffer.length) continue;
        yield buffer;
        buffer.fill(0);
        buffer = Buffer.alloc(BODY_CHUNK_BYTES);
        length = 0;
      }
    }
    if (length > 0) yield buffer.subarray(0, length);
  } finally {
    buffer.fill(0);
  }
}

async function* ownedSourceChunks(
  body: AsyncIterable<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let received = 0;
  for await (const chunk of body) {
    const clear = (): void => {
      chunk.fill(0);
    };
    signal.addEventListener('abort', clear, { once: true });
    try {
      received += chunk.byteLength;
      assertBodyByteLimit(received, limit);
      yield chunk;
    } finally {
      signal.removeEventListener('abort', clear);
      clear();
    }
  }
}

function assertBodyByteLimit(bytes: number, limit: number): void {
  if (bytes > limit)
    throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, {
      possiblyDispatched: true,
      ambiguous: false,
    });
}
