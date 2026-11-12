import { describe, expect, it } from 'vitest';
import { canonicalJsonVectors } from '../../../../infrastructure/testing/canonical-json-vectors.mjs';
import { canonicalJson } from '../../src/values/json/canonical.js';
import { canonicalWorkflowPortableJson } from '../../src/authoring/portability/portable-manifest.js';

describe('persisted workflow JSON encoding contracts', () => {
  it.each(canonicalJsonVectors)('$name', ({ input, ecmascript, lexical }) => {
    expect(canonicalJson(input)).toBe(ecmascript);
    expect(canonicalWorkflowPortableJson(input)).toBe(lexical);
  });
});
