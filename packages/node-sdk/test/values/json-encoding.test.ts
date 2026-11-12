import { canonicalizeBoundedJson } from '../../src/values/boundary.js';
import { InvalidBoundedJsonError } from '../../src/execution/node-execution.errors.js';
import { describe, expect, it } from 'vitest';
import { canonicalJsonVectors } from '../../../../infrastructure/testing/canonical-json-vectors.mjs';
import { encodeCanonicalJson, encodeJson } from '../../src/index.js';

describe('shared JSON encoding contract', () => {
  it.each(canonicalJsonVectors)('$name', ({ input, lexical }) => {
    const snapshot = canonicalizeBoundedJson(input);
    expect(encodeCanonicalJson(snapshot)).toBe(lexical);
    expect(encodeJson(snapshot)).toBe(JSON.stringify(input));
  });
  it('measures admitted data without calling inherited array serializers', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let calls = 0;
    let failure: unknown;
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        calls += 1;
        return null;
      },
    });
    try {
      canonicalizeBoundedJson(['too long for eight bytes'], {
        bytes: 8,
        depth: 4,
        members: 10,
      });
    } catch (error) {
      failure = error;
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', previous);
    }
    expect(calls).toBe(0);
    expect(failure).toBeInstanceOf(InvalidBoundedJsonError);
    expect((failure as Error).message).toContain('JSON byte limit exceeded');
  });
});
