import { SECURE_HTTP_ERROR_CODE, failure } from './secure-error.js';
import { decodedBodyView, type DecodedBodyView } from './decoded-body-view.js';
import { prepareSensitiveBytePatterns } from './sensitive-representations.js';

/** The documented bound includes the outer response's JSON-string encoding. */
const JSON_ESCAPE_LAYERS = 4;
const MASK = Buffer.from('[Redacted]');
class MatchingState {
  readonly edges = new Map<number, MatchingState>();
  fallback: MatchingState = this;
  length = 0;
}
interface Match {
  start: number;
  end: number;
}

/** One response-scoped automaton matches every credential representation together. */
export function prepareResponseRedactor(
  sensitiveValues: readonly string[],
  rawByteLimit = 131_072,
) {
  let decodingBytesLeft = Math.min(
    1_048_576,
    Math.max(32_768, 8 * rawByteLimit),
  );
  const decode = (parent: DecodedBodyView, format: 'json' | 'percent') => {
    if (!parent.bytes.includes(format === 'json' ? 92 : 37)) return undefined;
    // Charge the input before allocating escape spans, including repeated suffixes.
    if (parent.bytes.length > decodingBytesLeft)
      throw failure(SECURE_HTTP_ERROR_CODE.responseRedactionLimit, {
        possiblyDispatched: true,
        ambiguous: false,
      });
    decodingBytesLeft -= parent.bytes.length;
    return decodedBodyView(parent.bytes, format);
  };
  const root = new MatchingState();
  const patterns = prepareSensitiveBytePatterns(sensitiveValues);
  let maximum = 0;
  for (const pattern of patterns) {
    maximum = Math.max(maximum, pattern.length);
    let state = root;
    for (const byte of pattern) {
      let next = state.edges.get(byte);
      if (next === undefined) {
        next = new MatchingState();
        next.fallback = root;
        state.edges.set(byte, next);
      }
      state = next;
    }
    state.length = Math.max(state.length, pattern.length);
    pattern.fill(0);
  }
  const queue = [...root.edges.values()];
  for (const parent of queue) {
    for (const [byte, child] of parent.edges) {
      let fallback = parent.fallback;
      while (fallback !== root && !fallback.edges.has(byte))
        fallback = fallback.fallback;
      const target = fallback.edges.get(byte) ?? root;
      child.fallback = target;
      child.length = Math.max(child.length, target.length);
      queue.push(child);
    }
  }
  const find = (view: DecodedBodyView, matches: Match[]): void => {
    let state = root;
    let index = 0;
    for (const byte of view.bytes) {
      while (state !== root && !state.edges.has(byte)) state = state.fallback;
      state = state.edges.get(byte) ?? root;
      index += 1;
      if (state.length !== 0)
        matches.push({
          start: view.sourceStart(index - state.length),
          end: view.sourceEnd(index),
        });
    }
  };
  const redact = (
    source: Buffer,
    { final = true, covered = 0 } = {},
  ): Readonly<{ emitted: Buffer; remaining: Buffer; covered: number }> => {
    if (maximum === 0)
      return {
        emitted: Buffer.from(source),
        remaining: Buffer.alloc(0),
        covered: 0,
      };
    const identity: DecodedBodyView = {
      bytes: source,
      sourceStart: (position) => position,
      sourceEnd: (position) => position,
      sourceBoundary: (position) => position,
    };
    const views: DecodedBodyView[] = [identity];
    try {
      let previous: DecodedBodyView = identity;
      for (let layer = 0; layer < JSON_ESCAPE_LAYERS; layer += 1) {
        const parent: DecodedBodyView = previous;
        const decoded = decode(parent, 'json');
        if (decoded === undefined) break;
        previous = originalOffsets(parent, decoded);
        views.push(previous);
      }
      for (const parent of [...views]) {
        const decoded = decode(parent, 'percent');
        if (decoded !== undefined) views.push(originalOffsets(parent, decoded));
      }
      // Every decoding layer needs its own unfinished escape and credential suffix.
      // Map that suffix back to raw bytes rather than multiplying by 6^depth.
      let end = source.length;
      if (!final)
        for (const view of views)
          end = Math.min(
            end,
            view.sourceStart(Math.max(0, view.bytes.length - maximum - 11)),
          );
      const matches: Match[] = [];
      for (const view of views) find(view, matches);
      matches.sort(
        (left, right) => left.start - right.start || right.end - left.end,
      );
      const parts: Buffer[] = [];
      let written = covered;
      for (const match of matches) {
        if (match.start >= end) break;
        if (match.start < written) written = Math.max(written, match.end);
        else {
          parts.push(source.subarray(written, match.start), MASK);
          written = match.end;
        }
      }
      if (written < end) {
        parts.push(source.subarray(written, end));
        written = end;
      }
      return {
        emitted: Buffer.concat(parts),
        remaining: Buffer.from(source.subarray(end)),
        covered: written - end,
      };
    } finally {
      for (const view of views.slice(1)) view.bytes.fill(0);
    }
  };
  return {
    redact,
    text(value: string): string {
      const source = Buffer.from(value);
      try {
        return redact(source).emitted.toString('utf8');
      } finally {
        source.fill(0);
      }
    },
  };
}
export type ResponseRedactor = ReturnType<typeof prepareResponseRedactor>;

function originalOffsets(
  parent: DecodedBodyView,
  decoded: DecodedBodyView,
): DecodedBodyView {
  return {
    bytes: decoded.bytes,
    sourceStart: (position) =>
      parent.sourceStart(decoded.sourceStart(position)),
    sourceEnd: (position) => parent.sourceEnd(decoded.sourceEnd(position)),
    sourceBoundary: (position) => parent.sourceBoundary(position),
  };
}
