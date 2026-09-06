import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  failure,
  abortFailure,
  isTimeoutError,
} from './secure-http-error.js';

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return new Uint8Array(right);
  if (right.byteLength === 0) return new Uint8Array(left);
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

const REDACTED_BYTES = new TextEncoder().encode('[Redacted]');

async function redactAvailable(
  value: Uint8Array,
  patterns: readonly Uint8Array[],
  final: boolean,
  outputBudget: number,
  signal: AbortSignal,
  deadline: number,
): Promise<Readonly<{ emitted: Uint8Array; remaining: Uint8Array }>> {
  if (patterns.length === 0) {
    if (value.byteLength > outputBudget)
      throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, true, false);
    return Object.freeze({
      emitted: new Uint8Array(value),
      remaining: new Uint8Array(),
    });
  }
  const maximumPatternBytes = patterns[0]?.byteLength ?? 0;
  const emitted = new Uint8Array(
    Math.min(outputBudget, value.byteLength * REDACTED_BYTES.byteLength),
  );
  let emittedLength = 0;
  const append = (bytes: Uint8Array): void => {
    if (emittedLength + bytes.byteLength > outputBudget)
      throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, true, false);
    emitted.set(bytes, emittedLength);
    emittedLength += bytes.byteLength;
  };
  let index = 0;
  let comparisons = 0;
  while (index < value.byteLength) {
    if (!final && value.byteLength - index < maximumPatternBytes) break;
    let match: Uint8Array | undefined;
    for (const pattern of patterns) {
      let offset = 0;
      while (offset < pattern.byteLength) {
        comparisons += 1;
        if (comparisons >= 4_096) {
          comparisons = 0;
          await yieldToEventLoop();
          assertBodyDeadline(signal, deadline);
        }
        if (value[index + offset] !== pattern[offset]) break;
        offset += 1;
      }
      if (offset === pattern.byteLength) {
        match = pattern;
        break;
      }
    }
    if (match !== undefined) {
      append(REDACTED_BYTES);
      index += match.byteLength;
      continue;
    }
    const byte = value[index];
    if (byte === undefined) break;
    append(Uint8Array.of(byte));
    index += 1;
  }
  return Object.freeze({
    emitted: emitted.slice(0, emittedLength),
    remaining: value.slice(index),
  });
}

async function redactAndClear(
  value: Uint8Array,
  patterns: readonly Uint8Array[],
  final: boolean,
  outputBudget: number,
  signal: AbortSignal,
  deadline: number,
): ReturnType<typeof redactAvailable> {
  try {
    assertBodyDeadline(signal, deadline);
    return await redactAvailable(
      value,
      patterns,
      final,
      outputBudget,
      signal,
      deadline,
    );
  } finally {
    value.fill(0);
  }
}

export async function* boundedRedactedBody(
  body: AsyncIterable<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  sensitiveValues: readonly string[],
  deadline: number,
): AsyncGenerator<Uint8Array> {
  const patterns = sensitiveValues
    .map((value) => new TextEncoder().encode(value))
    .sort((left, right) => right.byteLength - left.byteLength);
  let rawBytes = 0;
  let emittedBytes = 0;
  let pending: Uint8Array = new Uint8Array();
  const emit = (value: Uint8Array): Uint8Array | undefined => {
    if (value.byteLength === 0) return undefined;
    emittedBytes += value.byteLength;
    if (emittedBytes > limit)
      throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, true, false);
    return value;
  };
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw abortFailure(signal, true, false);
      rawBytes += chunk.byteLength;
      if (rawBytes > limit)
        throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, true, false);
      const previous = pending;
      try {
        pending = concatenateBytes(previous, chunk);
      } finally {
        previous.fill(0);
        chunk.fill(0);
      }
      // Buffered iterators may only schedule microtasks. Yield even for small
      // chunks so caller cancellation and timeout timers can make progress.
      await yieldToEventLoop();
      const candidate = pending;
      const redacted = await redactAndClear(
        candidate,
        patterns,
        false,
        limit - emittedBytes,
        signal,
        deadline,
      );
      pending = redacted.remaining;
      const output = emit(redacted.emitted);
      if (output !== undefined) yield output;
    }
    const candidate = pending;
    const redacted = await redactAndClear(
      candidate,
      patterns,
      true,
      limit - emittedBytes,
      signal,
      deadline,
    );
    pending = redacted.remaining;
    const output = emit(redacted.emitted);
    if (output !== undefined) yield output;
  } catch (error: unknown) {
    if (error instanceof SecureHttpError) throw error;
    throw mapResponseStreamError(error, signal);
  } finally {
    pending.fill(0);
  }
}

function assertBodyDeadline(signal: AbortSignal, deadline: number): void {
  if (signal.aborted) throw abortFailure(signal, true, true);
  if (performance.now() >= deadline)
    throw failure(SECURE_HTTP_ERROR_CODE.timedOut, true, true);
}

function mapResponseStreamError(
  error: unknown,
  signal: AbortSignal | undefined,
): SecureHttpError {
  if (signal?.aborted === true) return abortFailure(signal, true, true);
  if (isTimeoutError(error))
    return failure(SECURE_HTTP_ERROR_CODE.timedOut, true, true, error);
  return failure(SECURE_HTTP_ERROR_CODE.networkFailed, true, true, error);
}
