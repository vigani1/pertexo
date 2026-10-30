import { describe, expect, it } from 'vitest';

import type { WorkflowCheckpoint } from '../../../src/index.js';
import {
  advanceWorkflow,
  createLoopState,
  invocationKey,
} from '../../support/engine.js';
import { startStructuredLoop } from '../../support/transition/model.js';

const scope = {
  controlInvocationKey: 'loop-control',
  branchPath: [],
  iterationPath: [],
  bodyRootNodeIds: ['body'],
  bodySinkNodeId: 'body',
} as const;

describe('bounded ForEach scheduling', () => {
  it('admits canonical bounded batches and spends the run budget once at loop start', () => {
    const { declared, schedulerState } = startStructuredLoop({
      bodyNodeCount: 1,
      collectionSize: 4,
      maxConcurrency: 2,
      reserveBudget: 6,
    });
    expect(runningOrdinals(declared.checkpoint)).toEqual([0, 1]);
    expect(declared.checkpoint.remainingIterationBudget).toBe(6);
    const second = declared.checkpoint.invocations.find(
      ({ iterationPath, status }) =>
        status === 'running' && iterationPath?.[0]?.ordinal === 1,
    );
    if (second === undefined) throw new Error('iteration 1 was not admitted');
    const next = advanceWorkflow({
      checkpoint: declared.checkpoint,
      schedulerState,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 16,
      observations: [
        {
          kind: 'loop_iteration_completed',
          loopId: 'loop',
          controlInvocationKey: required(declared.checkpoint.loops[0])
            .controlInvocationKey,
          invocationKey: second.invocationKey,
          ordinal: 1,
          status: 'succeeded',
        },
      ],
    });
    expect(runningOrdinals(next.checkpoint)).toEqual([0, 2]);
    expect(next.checkpoint.remainingIterationBudget).toBe(6);
  });

  it('rejects an over-limit collection before admitting any iteration', () => {
    expect(() =>
      createLoopState({
        ...scope,
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

  it('completes an empty collection without admissions or budget', () => {
    const { declared } = startStructuredLoop({
      bodyNodeCount: 1,
      collectionSize: 0,
      maxConcurrency: 1,
      reserveBudget: 10,
    });
    expect(runningOrdinals(declared.checkpoint)).toEqual([]);
    expect(declared.checkpoint.remainingIterationBudget).toBe(10);
  });

  it('rejects nested expansion when the pinned run-wide budget is exhausted', () => {
    expect(() =>
      createLoopState({
        ...scope,
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
      workflowVersionId: '00000000-0000-4000-8000-000000000006',
      nodeId: 'node',
      branchPath: ['branch-b'],
      iterationPath: [{ loopNodeId: 'loop', ordinal: 2 }],
    } as const;
    expect(invocationKey(input)).toBe(
      '00000000-0000-4000-8000-000000000006|node|b:branch-b|i:loop%3A2',
    );
    expect(invocationKey({ ...input, workflowVersionId: 'changed' })).not.toBe(
      invocationKey(input),
    );
    expect(invocationKey({ ...input, nodeId: 'changed' })).not.toBe(
      invocationKey(input),
    );
    expect(invocationKey({ ...input, branchPath: ['branch-a'] })).not.toBe(
      invocationKey(input),
    );
    expect(
      invocationKey({
        ...input,
        iterationPath: [{ loopNodeId: 'loop', ordinal: 3 }],
      }),
    ).not.toBe(invocationKey(input));
  });
});

function runningOrdinals(checkpoint: WorkflowCheckpoint): readonly number[] {
  return checkpoint.invocations
    .filter(({ status }) => status === 'running')
    .flatMap(({ iterationPath }) =>
      iterationPath?.[0] === undefined ? [] : [iterationPath[0].ordinal],
    )
    .sort((left, right) => left - right);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('loop state is missing');
  return value;
}
