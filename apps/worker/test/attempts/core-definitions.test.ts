import { describe, expect, it } from 'vitest';

import {
  isWorkerCoreMergeDefinition,
  isWorkerCoreParallelDefinition,
} from '../../src/attempts/core-definitions.js';

describe('worker core definition identities', () => {
  it.each([
    [undefined, false, false],
    [{ key: 'core.merge', version: 1 }, true, false],
    [{ key: 'core.merge', version: 1 }, true, false],
    [{ key: 'core.merge', version: 1 }, true, false],
    [{ key: 'core.merge', version: 4 }, false, false],
    [{ key: 'core.parallel', version: 1 }, false, true],
    [{ key: 'core.parallel', version: 1 }, false, true],
    [{ key: 'core.parallel', version: 1 }, false, true],
    [{ key: 'core.parallel', version: 0 }, false, false],
    [{ key: 'core.condition', version: 1 }, false, false],
  ] as const)(
    'recognizes exact Merge and Parallel identities %#',
    (definition, merge, parallel) => {
      expect(isWorkerCoreMergeDefinition(definition)).toBe(merge);
      expect(isWorkerCoreParallelDefinition(definition)).toBe(parallel);
    },
  );
});
