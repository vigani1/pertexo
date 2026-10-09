import { describe, expect, it } from 'vitest';

import { requiresStructuredCheckpoint } from '../../src/runs/initial-checkpoint.js';

describe('initial checkpoint schema', () => {
  it.each([
    ['core.condition', 1, true],
    ['core.switch', 1, true],
    ['core.foreach', 1, true],
    ['core.parallel', 1, true],
    ['core.parallel', 2, true],
    ['core.parallel', 3, true],
    ['core.parallel', 4, false],
    ['core.merge', 1, false],
    ['core.merge', 3, false],
    ['core.manual', 1, false],
  ] as const)(
    'uses the structured checkpoint for %s v%i: %s',
    (key, version, structured) => {
      expect(requiresStructuredCheckpoint({ key, version })).toBe(structured);
    },
  );
});
