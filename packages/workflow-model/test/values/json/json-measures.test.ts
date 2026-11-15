import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { measureBoundedJson } from '../../../src/values/json/bounded-json-size.js';
import {
  canonicalizeJson,
  inspectJsonValue,
} from '../../../src/values/json/canonical.js';

// Stored values are measured natively and untrusted input by the walk; a value
// must cost the same either way, or a stored value could pass one guard and
// fail the other.
describe('JSON measures', () => {
  it('gives a normalized value the same bytes, depth and members through either measure', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const normalized = canonicalizeJson(value);
        const { bytes, depth, members } = inspectJsonValue(normalized);
        expect(measureBoundedJson(normalized)).toEqual({
          ok: true,
          bytes,
          depth,
          members,
        });
      }),
    );
  });

  it('agrees on text that needs escapes and on characters outside the basic plane', () => {
    const value = {
      'quote"and\\slash': ['line\nbreak', '\u0001', 'é', '😀', ' '],
      nested: { empty: {}, list: [] },
    };
    const { bytes, depth, members } = inspectJsonValue(value);
    expect(measureBoundedJson(canonicalizeJson(value))).toEqual({
      ok: true,
      bytes,
      depth,
      members,
    });
  });
});
