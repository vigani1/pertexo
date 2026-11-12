import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@pertexo/workflow-model';
import { canonicalJsonVectors } from '../../../../../infrastructure/testing/canonical-json-vectors.mjs';

describe('browser command JSON identity', () => {
  it.each(canonicalJsonVectors)('$name', ({ input, ecmascript }) => {
    expect(canonicalJson(input)).toBe(ecmascript);
  });
});
