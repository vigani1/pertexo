import { describe, expect, it } from 'vitest';

import { invocationKey, loopIterationOrdinal } from '../../src/index.js';

const version = '01900000-0000-7000-8000-000000000001';

describe('loop iteration ordinal', () => {
  it('reads the pass a body step ran in, whatever its branch', () => {
    for (const ordinal of [0, 7, 4_997])
      expect(
        loopIterationOrdinal(
          invocationKey({
            workflowVersionId: version,
            nodeId: 'shape',
            branchPath: ['check:true'],
            iterationPath: [{ loopNodeId: 'each', ordinal }],
          }),
          'each',
        ),
      ).toBe(ordinal);
  });

  it('keeps to the loop instance inside its enclosing passes', () => {
    const key = invocationKey({
      workflowVersionId: version,
      nodeId: 'shape',
      iterationPath: [
        { loopNodeId: 'outer', ordinal: 2 },
        { loopNodeId: 'inner', ordinal: 5 },
      ],
    });
    expect(
      loopIterationOrdinal(key, 'inner', [{ loopNodeId: 'outer', ordinal: 2 }]),
    ).toBe(5);
    expect(
      loopIterationOrdinal(key, 'inner', [{ loopNodeId: 'outer', ordinal: 3 }]),
    ).toBeUndefined();
    expect(loopIterationOrdinal(key, 'outer')).toBeUndefined();
    expect(loopIterationOrdinal(key, 'inner')).toBeUndefined();
  });

  it('does not mistake a loop whose name starts the same', () => {
    const key = invocationKey({
      workflowVersionId: version,
      nodeId: 'shape',
      iterationPath: [{ loopNodeId: 'each:1', ordinal: 3 }],
    });
    expect(loopIterationOrdinal(key, 'each')).toBeUndefined();
    expect(
      loopIterationOrdinal(
        invocationKey({ workflowVersionId: version, nodeId: 'shape' }),
        'each',
      ),
    ).toBeUndefined();
  });
});
