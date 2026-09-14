import { parseCheckpoint } from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

import {
  createWorkerInitialCheckpoint,
  isWorkerCoreMergeDefinition,
  isWorkerCoreParallelDefinition,
} from '../src/execution/core-definition-identities.js';

describe('worker core definition checkpoint selection', () => {
  it.each([
    ['core.condition', 1, 2],
    ['core.switch', 1, 2],
    ['core.foreach', 1, 2],
    ['core.parallel', 1, 2],
    ['core.parallel', 2, 2],
    ['core.parallel', 3, 2],
    ['core.parallel', 4, 1],
    ['core.merge', 1, 1],
    ['core.merge', 2, 1],
    ['core.merge', 3, 1],
    ['core.manual', 1, 1],
  ] as const)(
    'selects checkpoint schema $2 for $0 v$1',
    (key, version, schemaVersion) => {
      const executable = {
        envelope: {
          graph: {
            nodes: [
              { definition: { key: 'core.manual', version: 1 } },
              { definition: { key, version } },
            ],
          },
        },
      } as never;

      const initial = createWorkerInitialCheckpoint(
        executable,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );

      expect(parseCheckpoint(initial.checkpoint)).toMatchObject({
        schemaVersion,
      });
    },
  );

  it.each([
    [undefined, false, false],
    [{ key: 'core.merge', version: 1 }, true, false],
    [{ key: 'core.merge', version: 2 }, true, false],
    [{ key: 'core.merge', version: 3 }, true, false],
    [{ key: 'core.merge', version: 4 }, false, false],
    [{ key: 'core.parallel', version: 1 }, false, true],
    [{ key: 'core.parallel', version: 2 }, false, true],
    [{ key: 'core.parallel', version: 3 }, false, true],
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
