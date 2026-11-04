import { decodedBodyView, type DecodedBodyView } from './decoded-body-view.js';
import { prepareSensitiveBytePatterns } from './sensitive-representations.js';
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
const BODY_CHUNK_BYTES = 65_536;
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
    assertBodyByteLimit(value.byteLength, outputBudget);
    return Object.freeze({
      emitted: new Uint8Array(value),
      remaining: new Uint8Array(),
      covered: 0,
    });
  }
  const maximumPatternBytes = patterns[0]?.byteLength ?? 0;
  // Until the body ends, the last bytes could be the start of a secret that
  // finishes in the next chunk, so only what comes before them is decided.
  let decidedEnd = final
    ? value.byteLength
    : Math.max(0, value.byteLength - maximumPatternBytes * 6 - 11 + 1);
  if (decidedEnd === 0)
    return { emitted: new Uint8Array(), remaining: value.slice(), covered };
  const emitted = new Uint8Array(
    Math.min(outputBudget, value.byteLength * REDACTED_BYTES.byteLength),
  );
  let emittedLength = 0;
  const append = (bytes: Uint8Array): void => {
    assertBodyByteLimit(emittedLength + bytes.byteLength, outputBudget);
    emitted.set(bytes, emittedLength);
    emittedLength += bytes.byteLength;
  };
  // A view, not a copy: the caller clears these bytes, and only these.
  const source = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let comparisons = 0;
  const compared = (): boolean => ++comparisons >= COMPARISONS_BEFORE_YIELD;
  const yieldComparisons = async (): Promise<void> => {
    comparisons = 0;
    await yieldToEventLoop();
    assertBodyDeadline(signal, deadline);
  };
  const decoded = decodedBodyView(source);
  try {
    decidedEnd = decoded?.sourceBoundary(decidedEnd) ?? decidedEnd;
    const views: readonly DecodedBodyView[] = [
      {
        bytes: source,
        sourceStart: (position) => position,
        sourceEnd: (position) => position,
        sourceBoundary: (position) => position,
      },
      ...(decoded === undefined ? [] : [decoded]),
    ];
    const searches = views.flatMap((view) =>
      patterns.map((pattern) => ({
        pattern,
        view,
        at: NOT_SEARCHED,
        end: 0,
        from: 0,
      })),
    );
    const nextMatch = async (
      search: (typeof searches)[number],
      minimum: number,
    ): Promise<void> => {
      const { pattern, view } = search;
      const firstByte = pattern.subarray(0, 1);
      let position = view.bytes.indexOf(firstByte, search.from);
      while (position !== NOT_FOUND) {
        const start = view.sourceStart(position);
        if (start >= decidedEnd) break;
        if (start >= minimum) {
          if (compared()) await yieldComparisons();
          let offset = 1;
          while (offset < pattern.byteLength) {
            if (compared()) await yieldComparisons();
            if (view.bytes[position + offset] !== pattern[offset]) break;
            offset += 1;
          }
          if (offset === pattern.byteLength) {
            search.at = start;
            search.end = view.sourceEnd(position + pattern.byteLength);
            search.from = position + 1;
            return;
          }
        }
        position = view.bytes.indexOf(firstByte, position + 1);
      }
      search.at = NOT_FOUND;
    };
    let written = covered;
    let index = 0;
    while (index < decidedEnd) {
      let earliest: (typeof searches)[number] | undefined;
      for (const search of searches) {
        if (search.at !== NOT_FOUND && search.at < index)
          await nextMatch(search, index);
        if (
          search.at !== NOT_FOUND &&
          (earliest === undefined || matchPrecedes(search, earliest))
        )
          earliest = search;
      }
      if (earliest === undefined) break;
      const end = earliest.end;
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
  } finally {
    decoded?.bytes.fill(0);
  }
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
  const patterns = prepareSensitiveBytePatterns(sensitiveValues);
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
    for await (const chunk of boundedSourceChunks(body, limit, signal)) {
      if (signal.aborted)
        throw abortFailure(signal, {
          possiblyDispatched: true,
          ambiguous: false,
        });
      const previous = pending;
      try {
        pending = concatenateBytes(previous, chunk);
      } finally {
        previous.fill(0);
      }
      // Yield even for buffered iterators so cancellation/deadline timers progress.
      await yieldToEventLoop();
      const redacted = await redactAndClear(pending, patterns, {
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
    for (const pattern of patterns) pattern.fill(0);
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

function matchPrecedes(
  left: Readonly<{ at: number; end: number }>,
  right: Readonly<{ at: number; end: number }>,
): boolean {
  return left.at < right.at || (left.at === right.at && left.end > right.end);
}

/** Bound decoding work per turn while retaining ownership of every source chunk. */
async function* boundedSourceChunks(
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
      if (chunk.byteLength === 0) yield chunk;
      for (
        let offset = 0;
        offset < chunk.byteLength;
        offset += BODY_CHUNK_BYTES
      )
        yield chunk.subarray(offset, offset + BODY_CHUNK_BYTES);
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
