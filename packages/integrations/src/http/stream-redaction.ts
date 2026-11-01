import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  SECURE_HTTP_ERROR_CODE,
  type SecureHttpError,
  failure,
  abortFailure,
  inspectSecureHttpError,
  isTimeoutError,
} from './secure-error.js';

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return new Uint8Array(right);
  if (right.byteLength === 0) return new Uint8Array(left);
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

const REDACTED_BYTES = new TextEncoder().encode('[Redacted]');
const COMPARISONS_BEFORE_YIELD = 4_096;
const NOT_FOUND = -1;
const NOT_SEARCHED = -2;

type RedactionStep = Readonly<{
  /** How many leading bytes the previous step already redacted. */
  covered: number;
  final: boolean;
  outputBudget: number;
  signal: AbortSignal;
  deadline: number;
}>;

type RedactionResult = Readonly<{
  emitted: Uint8Array;
  remaining: Uint8Array;
  covered: number;
}>;

async function redactAvailable(
  value: Uint8Array,
  patterns: readonly Uint8Array[],
  { covered, final, outputBudget, signal, deadline }: RedactionStep,
): Promise<RedactionResult> {
  if (patterns.length === 0) {
    if (value.byteLength > outputBudget)
      throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    return Object.freeze({
      emitted: new Uint8Array(value),
      remaining: new Uint8Array(),
      covered: 0,
    });
  }
  const maximumPatternBytes = patterns[0]?.byteLength ?? 0;
  // Until the body ends, the last bytes could be the start of a secret that
  // finishes in the next chunk, so only what comes before them is decided.
  const decidedEnd = final
    ? value.byteLength
    : Math.max(0, value.byteLength - maximumPatternBytes + 1);
  const emitted = new Uint8Array(
    Math.min(outputBudget, value.byteLength * REDACTED_BYTES.byteLength),
  );
  let emittedLength = 0;
  const append = (bytes: Uint8Array): void => {
    if (emittedLength + bytes.byteLength > outputBudget)
      throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    emitted.set(bytes, emittedLength);
    emittedLength += bytes.byteLength;
  };
  // A view, not a copy: the caller clears these bytes, and only these.
  const source = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let comparisons = 0;
  const compared = async (): Promise<void> => {
    comparisons += 1;
    if (comparisons < COMPARISONS_BEFORE_YIELD) return;
    comparisons = 0;
    await yieldToEventLoop();
    assertBodyDeadline(signal, deadline);
  };
  /**
   * Jumps between a pattern's first byte, which is what makes an ordinary body
   * fast. Not `indexOf` on the whole pattern: on a hostile body that holds the
   * event loop for seconds, where these comparisons stay counted and cancellable.
   */
  const nextMatch = async (
    pattern: Uint8Array,
    from: number,
  ): Promise<number> => {
    const firstByte = pattern.subarray(0, 1);
    let position = source.indexOf(firstByte, from);
    while (position !== NOT_FOUND && position < decidedEnd) {
      await compared();
      let offset = 1;
      while (offset < pattern.byteLength) {
        await compared();
        if (value[position + offset] !== pattern[offset]) break;
        offset += 1;
      }
      if (offset === pattern.byteLength) return position;
      position = source.indexOf(firstByte, position + 1);
    }
    return NOT_FOUND;
  };
  // Each pattern's next match holds until the scan passes it, so every pattern
  // walks the bytes once. Patterns come longest first, so where several start at
  // the same byte the longest wins. The scan moves one byte past a match rather
  // than past its end: a secret can start inside the one just found, and none of
  // it may come out, so overlapping matches redact as one range.
  const searches = patterns.map((pattern) => ({ pattern, at: NOT_SEARCHED }));
  let written = covered;
  let index = 0;
  while (index < decidedEnd) {
    let earliest: (typeof searches)[number] | undefined;
    for (const search of searches) {
      if (search.at !== NOT_FOUND && search.at < index)
        search.at = await nextMatch(search.pattern, index);
      if (
        search.at !== NOT_FOUND &&
        (earliest === undefined || search.at < earliest.at)
      )
        earliest = search;
    }
    if (earliest === undefined) break;
    const end = earliest.at + earliest.pattern.byteLength;
    if (earliest.at < written) written = Math.max(written, end);
    else {
      append(value.subarray(written, earliest.at));
      append(REDACTED_BYTES);
      written = end;
    }
    index = earliest.at + 1;
  }
  if (written < decidedEnd) {
    append(value.subarray(written, decidedEnd));
    written = decidedEnd;
  }
  // Starts from the first byte no search has tried, even if a match already
  // covers it: the next chunk can finish a secret that starts there.
  return Object.freeze({
    emitted: emitted.slice(0, emittedLength),
    remaining: value.slice(decidedEnd),
    covered: written - decidedEnd,
  });
}

async function redactAndClear(
  value: Uint8Array,
  patterns: readonly Uint8Array[],
  step: RedactionStep,
): Promise<RedactionResult> {
  try {
    assertBodyDeadline(step.signal, step.deadline);
    return await redactAvailable(value, patterns, step);
  } finally {
    value.fill(0);
  }
}

export async function* boundedRedactedBody(
  body: AsyncIterable<Uint8Array>,
  {
    limit,
    signal,
    sensitiveValues,
    deadline,
  }: Readonly<{
    limit: number;
    signal: AbortSignal;
    sensitiveValues: readonly string[];
    deadline: number;
  }>,
): AsyncGenerator<Uint8Array> {
  const patterns = sensitiveValues
    .map((value) => new TextEncoder().encode(value))
    .sort((left, right) => right.byteLength - left.byteLength);
  let rawBytes = 0;
  let emittedBytes = 0;
  let pending: Uint8Array = new Uint8Array();
  let covered = 0;
  const emit = (value: Uint8Array): Uint8Array | undefined => {
    if (value.byteLength === 0) return undefined;
    emittedBytes += value.byteLength;
    if (emittedBytes > limit)
      throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    return value;
  };
  try {
    for await (const chunk of body) {
      const clearChunk = (): void => {
        chunk.fill(0);
      };
      signal.addEventListener('abort', clearChunk, { once: true });
      try {
        if (signal.aborted)
          throw abortFailure(signal, {
            possiblyDispatched: true,
            ambiguous: false,
          });
        rawBytes += chunk.byteLength;
        if (rawBytes > limit)
          throw failure(SECURE_HTTP_ERROR_CODE.responseTooLarge, {
            possiblyDispatched: true,
            ambiguous: false,
          });
        const previous = pending;
        try {
          pending = concatenateBytes(previous, chunk);
        } finally {
          previous.fill(0);
        }
        // Buffered iterators may only schedule microtasks. Yield even for small
        // chunks so caller cancellation and timeout timers can make progress.
        await yieldToEventLoop();
        const candidate = pending;
        const redacted = await redactAndClear(candidate, patterns, {
          covered,
          final: false,
          outputBudget: limit - emittedBytes,
          signal,
          deadline,
        });
        pending = redacted.remaining;
        covered = redacted.covered;
        const output = emit(redacted.emitted);
        if (output !== undefined) yield output;
      } finally {
        signal.removeEventListener('abort', clearChunk);
        clearChunk();
      }
    }
    const candidate = pending;
    const redacted = await redactAndClear(candidate, patterns, {
      covered,
      final: true,
      outputBudget: limit - emittedBytes,
      signal,
      deadline,
    });
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
