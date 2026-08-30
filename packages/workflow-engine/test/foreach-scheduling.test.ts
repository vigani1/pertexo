import { describe, expect, it } from 'vitest';

import {
  admitLoopIterations,
  completeLoopIteration,
  createLoopState,
  invocationKey,
} from '../src/index.js';

describe('bounded ForEach scheduling', () => {
  it('pins a collection reference and admits canonical bounded batches', () => {
    const loop = createLoopState({
      loopId: 'loop',
      collection: {
        kind: 'artifact',
        artifactId: '00000000-0000-4000-8000-000000000101',
      },
      collectionChecksum: 'sha256:abc',
      collectionSize: 4,
      maxIterations: 4,
      maxConcurrency: 2,
      remainingIterationBudget: 10,
    });
    const first = admitLoopIterations(loop, 10);
    expect(first.admittedOrdinals).toEqual([0, 1]);
    expect(
      admitLoopIterations(
        completeLoopIteration(first.loop, 1),
        first.remainingIterationBudget,
      ).admittedOrdinals,
    ).toEqual([2]);
  });

  it('rejects an over-limit collection before admitting any iteration', () => {
    expect(() =>
      createLoopState({
        loopId: 'loop',
        collection: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000103',
        },
        collectionChecksum: 'sha256:abc',
        collectionSize: 4,
        maxIterations: 3,
        maxConcurrency: 2,
        remainingIterationBudget: 10,
      }),
    ).toThrow(expect.objectContaining({ code: 'loop_limit_exceeded' }));
  });

  it('completes an empty collection without admissions', () => {
    const loop = createLoopState({
      loopId: 'empty',
      collection: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000104',
      },
      collectionChecksum: 'sha256:empty',
      collectionSize: 0,
      maxIterations: 10,
      maxConcurrency: 2,
      remainingIterationBudget: 10,
    });
    expect(admitLoopIterations(loop, 10)).toMatchObject({
      admittedOrdinals: [],
      remainingIterationBudget: 10,
    });
  });

  it('rejects nested expansion when the pinned run-wide budget is exhausted', () => {
    expect(() =>
      createLoopState({
        loopId: 'nested',
        collection: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000105',
        },
        collectionChecksum: 'sha256:nested',
        collectionSize: 2,
        maxIterations: 10,
        maxConcurrency: 2,
        remainingIterationBudget: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'loop_limit_exceeded' }));
  });

  it('derives stable invocation identity only from version, node, and canonical scope', () => {
    const input = {
      workflowVersionId: 'version',
      nodeId: 'node',
      branchPath: ['branch-b'],
      iterationPath: [{ loopNodeId: 'loop', ordinal: 2 }],
    } as const;
    expect(invocationKey(input)).toBe(invocationKey(input));
    expect(invocationKey(input)).toContain('loop%3A2');
  });
});
