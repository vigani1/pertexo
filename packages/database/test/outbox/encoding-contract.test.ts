import { describe, expect, it } from 'vitest';
import { canonicalJsonVectors } from '../../../../infrastructure/testing/canonical-json-vectors.mjs';
import { canonicalJson } from '../../src/outbox/canonical-json.js';

describe('persisted outbox JSON encoding contract', () => {
  it.each(canonicalJsonVectors)('$name', ({ input, lexical }) => {
    expect(canonicalJson(input, 4096)).toBe(lexical);
  });
});
