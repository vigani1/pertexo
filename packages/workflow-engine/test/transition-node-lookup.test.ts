import { describe, expect, it } from 'vitest';
import { boundedReadyAdmissions } from '../src/transition/decisions.js';
import {
  indexTransitionNodes,
  schedulerNodeDisabled,
  schedulerNodeSideEffectClass,
} from '../src/transition/state.js';

describe('transition-local scheduler node lookup', () => {
  it('keeps branch and enclosing-iteration limits separate and rejects missing loop scope', () => {
    const schedulerNodes = indexTransitionNodes({
      deriveReadiness: true,
      nodes: [],
      edges: [],
      structuredBodies: [
        {
          loopNodeId: 'loop',
          edges: [],
          nodes: [
            {
              id: 'parallel',
              sideEffectClass: 'safe',
              definition: { key: 'core.parallel', version: 1 },
              config: {
                maxConcurrency: 1,
                branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
              },
            },
          ],
        },
      ],
    });
    const branchPath = [
      { nodeId: 'outer', outputPort: 'left' },
      { nodeId: 'parallel', outputPort: 'branch-01' },
    ];
    const running = {
      invocationKey: 'running',
      nodeId: 'effect',
      status: 'running' as const,
      attemptNumber: 1,
      branchPath,
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    };
    const sameScope = {
      ...running,
      invocationKey: 'same',
      status: 'ready' as const,
    };
    const nextScope = {
      ...sameScope,
      invocationKey: 'next',
      iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
    };
    expect(
      boundedReadyAdmissions({
        schedulerNodes,
        maximumAdmissions: 2,
        invocations: [running, sameScope, nextScope],
        readySet: ['same', 'missing', 'next'],
      }),
    ).toEqual(['next']);
    expect(() =>
      boundedReadyAdmissions({
        schedulerNodes,
        maximumAdmissions: 1,
        invocations: [{ ...sameScope, iterationPath: [] }],
        readySet: ['same'],
      }),
    ).toThrow('missing its containing loop scope');
  });

  it('retains root and nested loop ownership with pinned admission fields', () => {
    const nodes = indexTransitionNodes({
      deriveReadiness: true,
      nodes: [{ id: 'root', sideEffectClass: 'safe' }],
      edges: [],
      structuredBodies: [
        {
          loopNodeId: 'outer',
          nodes: [{ id: 'nested-loop', sideEffectClass: 'safe' }],
          edges: [],
        },
        {
          loopNodeId: 'nested-loop',
          nodes: [{ id: 'effect', sideEffectClass: 'unsafe', disabled: true }],
          edges: [],
        },
      ],
    });
    expect(nodes?.get('root')?.containingLoopId).toBeUndefined();
    expect(nodes?.get('nested-loop')?.containingLoopId).toBe('outer');
    expect(nodes?.get('effect')?.containingLoopId).toBe('nested-loop');
    expect(Object.isFrozen(nodes?.get('effect'))).toBe(true);
    expect(schedulerNodeSideEffectClass(nodes, 'effect')).toBe('unsafe');
    expect(schedulerNodeDisabled(nodes, 'effect')).toBe(true);
    expect(schedulerNodeDisabled(nodes, 'root')).toBe(false);
  });

  it('does not reuse lookup state across transitions or soften missing-node admission', () => {
    const first = indexTransitionNodes({
      deriveReadiness: true,
      nodes: [{ id: 'same', sideEffectClass: 'unsafe', disabled: true }],
      edges: [],
    });
    const second = indexTransitionNodes({
      deriveReadiness: true,
      nodes: [{ id: 'same', sideEffectClass: 'safe' }],
      edges: [],
    });
    expect(first).not.toBe(second);
    expect(schedulerNodeSideEffectClass(second, 'same')).toBe('safe');
    expect(schedulerNodeDisabled(second, 'same')).toBe(false);
    expect(() => schedulerNodeSideEffectClass(second, 'missing')).toThrow(
      'scheduler node missing is missing',
    );
    expect(indexTransitionNodes(undefined)).toBeUndefined();
    expect(schedulerNodeDisabled(undefined, 'same')).toBe(false);
    expect(() => schedulerNodeSideEffectClass(undefined, 'same')).toThrow(
      'scheduler state is required',
    );
  });
});
