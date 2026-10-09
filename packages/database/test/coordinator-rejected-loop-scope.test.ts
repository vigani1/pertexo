import { expect, it } from 'vitest';
import { workflowForEachBoundsV2 } from '@pertexo/workflow-model/graph';
import { isRejectedForEachCollection } from '../src/runs/advance/rejected-loop-proof.js';

const bounds = workflowForEachBoundsV2({
  schemaVersion: 2,
  graph: {
    nodes: [
      {
        id: 'outer',
        definition: { key: 'core.foreach', version: 1 },
        structured: {
          kind: 'for_each',
          maxIterations: 10,
          maxConcurrency: 1,
          body: {
            nodes: [
              {
                id: 'inner',
                definition: { key: 'core.foreach', version: 1 },
                structured: {
                  kind: 'for_each',
                  maxIterations: 3,
                  maxConcurrency: 1,
                  body: { nodes: [] },
                },
              },
            ],
          },
        },
      },
    ],
  },
});
const base = {
  nodeId: 'inner',
  iterationPath: [{ loopNodeId: 'outer', ordinal: 0 }],
  value: { items: [1, 2, 3, 4], iterationCount: 4 },
  bounds,
  remainingIterationBudget: 10,
};
it('recognizes the pinned nested ancestor chain', () => {
  expect(isRejectedForEachCollection(base)).toBe(true);
});
it.each([
  [],
  [{ loopNodeId: 'wrong', ordinal: 0 }],
  [{ loopNodeId: 'outer', ordinal: -1 }],
  [{ loopNodeId: 'outer', ordinal: 0.5 }],
  [
    { loopNodeId: 'outer', ordinal: 0 },
    { loopNodeId: 'inner', ordinal: 0 },
  ],
])('rejects malformed or invented nested scope %j', (...iterationPath) => {
  expect(isRejectedForEachCollection({ ...base, iterationPath })).toBe(false);
});
it('rejects getters and malformed bounded values without evaluating accessors', () => {
  let accessed = false;
  const value = {
    get items() {
      accessed = true;
      return [1, 2, 3, 4];
    },
    iterationCount: 4,
  };
  expect(isRejectedForEachCollection({ ...base, value })).toBe(false);
  expect(accessed).toBe(false);
});
