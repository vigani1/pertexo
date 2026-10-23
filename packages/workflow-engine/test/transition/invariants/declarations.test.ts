import { describe, expect, it } from 'vitest';
import { advanceWorkflow } from '../../support/engine.js';
import { scopedLoopSinkInvocation } from '../../../src/transition/state.js';
import type { InvocationState, LoopState } from '../../../src/types.js';
import {
  occurredAt,
  ATTEMPT_ID,
  inline,
  advance,
  rootKey,
  loopBody,
  checkpoint,
} from '../../support/transition/invariants.js';

describe('workflow transition public risk behavior', () => {
  it('rejects duplicate sink invocations within the same loop iteration scope', () => {
    const branchPath = [{ nodeId: 'condition', outputPort: 'true' }];
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }];
    const loop: LoopState = {
      controlInvocationKey: 'loop-control',
      loopId: 'loop',
      branchPath,
      iterationPath: [],
      bodyRootNodeIds: ['body'],
      bodySinkNodeId: 'body',
      collection: inline(ATTEMPT_ID),
      collectionChecksum: 'sum',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 1,
      nextOrdinal: 1,
      activeOrdinals: [0],
      completedPrefix: 0,
      terminalOrdinals: [],
    };
    const sink: InvocationState = {
      invocationKey: 'sink-a',
      nodeId: 'body',
      status: 'succeeded',
      attemptNumber: 1,
      branchPath,
      iterationPath,
    };
    const otherBranch: InvocationState = {
      ...sink,
      invocationKey: 'other-branch',
      branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
    };
    expect(scopedLoopSinkInvocation(loop, 0, [sink, otherBranch])).toEqual(
      sink,
    );
    expect(() =>
      scopedLoopSinkInvocation(loop, 0, [
        sink,
        { ...sink, invocationKey: 'sink-b' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it.each([
    { joinId: '', branchIds: ['a'], policy: { kind: 'all' as const } },
    { joinId: 'join', branchIds: [], policy: { kind: 'all' as const } },
    { joinId: 'join', branchIds: [''], policy: { kind: 'all' as const } },
    { joinId: 'join', branchIds: ['a', 'a'], policy: { kind: 'all' as const } },
    {
      joinId: 'join',
      branchIds: ['a'],
      policy: { kind: 'count' as const, count: 0 },
    },
    {
      joinId: 'join',
      branchIds: ['a'],
      policy: { kind: 'count' as const, count: 1.5 },
    },
    {
      joinId: 'join',
      branchIds: ['a'],
      policy: { kind: 'count' as const, count: 2 },
    },
  ])('rejects an invalid join declaration %#', (observation) => {
    expect(() =>
      advance(checkpoint(), [
        {
          kind: 'join_declared',
          joinInvocationKey: rootKey('join'),
          ...observation,
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });
  it('accepts an identical join declaration replay without new work', () => {
    const declaration = {
      kind: 'join_declared' as const,
      joinId: 'join',
      joinInvocationKey: rootKey('join'),
      branchIds: ['a'],
      policy: { kind: 'all' as const },
    };
    const joinInput = {
      occurredAt,
      maximumAdmissions: 0,
      schedulerState: {
        deriveReadiness: false,
        nodes: [{ id: 'join', sideEffectClass: 'safe' as const }],
        edges: [],
      },
    } as const;
    const declared = advanceWorkflow({
      ...joinInput,
      checkpoint: checkpoint(),
      observations: [declaration],
    });
    const replayed = advanceWorkflow({
      ...joinInput,
      checkpoint: declared.checkpoint,
      observations: [declaration],
    });
    expect(replayed.checkpoint.joins).toEqual(declared.checkpoint.joins);
    expect(replayed.events).toEqual([]);
    expect(replayed.nodeRunAdmissions).toEqual([]);
    expect(replayed.attempts).toEqual([]);
  });
  it('rejects a conflicting join declaration replay', () => {
    const declaration = {
      kind: 'join_declared' as const,
      joinId: 'join',
      joinInvocationKey: rootKey('join'),
      branchIds: ['a'],
      policy: { kind: 'all' as const },
    };
    expect(() =>
      advance(checkpoint(), [
        declaration,
        { ...declaration, branchIds: ['b'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });
  it.each([
    { joinId: 'other' },
    { branchPath: [{ nodeId: 'condition', outputPort: 'true' }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }] },
  ])('rejects a join replay with changed durable identity %#', (changed) => {
    const declaration = {
      kind: 'join_declared' as const,
      joinId: 'join',
      joinInvocationKey: 'join-scope',
      branchIds: ['a'],
      branchPath: [],
      iterationPath: [],
      policy: { kind: 'all' as const },
    };
    expect(() =>
      advance(checkpoint(), [declaration, { ...declaration, ...changed }]),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });
  it('rejects a disposition for an undeclared join', () => {
    expect(() =>
      advance(checkpoint(), [
        {
          kind: 'branch_disposition',
          joinId: 'missing',
          joinInvocationKey: rootKey('missing'),
          branch: { branchId: 'a', disposition: 'arrived' },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });
  it('ignores new admissions and declarations after cancellation', () => {
    const plan = advance(checkpoint(), [
      { kind: 'cancel_requested' },
      { kind: 'ready', invocationKey: 'ready', nodeId: 'ready' },
      {
        kind: 'join_declared',
        joinId: 'join',
        joinInvocationKey: rootKey('join'),
        branchIds: ['a'],
        policy: { kind: 'all' },
      },
      {
        kind: 'loop_started',
        loopId: 'loop',
        controlInvocationKey: rootKey('loop'),
        ...loopBody,
        collection: inline(ATTEMPT_ID),
        collectionChecksum: 'sum',
        collectionSize: 0,
        maxConcurrency: 1,
        maxIterations: 1,
      },
    ]);
    expect(plan.checkpoint.invocations).toHaveLength(0);
    expect(plan.checkpoint.joins).toHaveLength(0);
    expect(plan.checkpoint.loops).toHaveLength(0);
  });
  it('uses the transition occurrence time when a deadline fact omits one', () => {
    const plan = advance(checkpoint(), [{ kind: 'deadline_expired' }]);
    expect(plan.checkpoint.deadlineExpired).toBe(true);
    expect(plan.events).toContainEqual(
      expect.objectContaining({
        occurredAt,
        name: 'run.timed_out',
      }),
    );
  });
  it('creates loop control state and rejects a conflicting replay', () => {
    const declaration = {
      kind: 'loop_started' as const,
      loopId: 'loop',
      controlInvocationKey: 'loop-control',
      ...loopBody,
      collection: inline(ATTEMPT_ID),
      collectionChecksum: 'sum',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 1,
    };
    expect(() =>
      advance(checkpoint(), [
        declaration,
        { ...declaration, collectionChecksum: 'different' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });
  it.each([
    { loopId: 'other' },
    { branchPath: [{ nodeId: 'condition', outputPort: 'true' }] },
    { iterationPath: [{ loopNodeId: 'outer', ordinal: 0 }] },
    { bodyRootNodeIds: ['different'] },
    { bodySinkNodeId: 'different' },
  ])('rejects a loop replay with changed durable topology %#', (changed) => {
    const declaration = {
      kind: 'loop_started' as const,
      loopId: 'loop',
      controlInvocationKey: 'loop-control',
      branchPath: [],
      iterationPath: [],
      bodyRootNodeIds: ['body'],
      bodySinkNodeId: 'body',
      collection: inline(ATTEMPT_ID),
      collectionChecksum: 'sum',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 1,
    };
    expect(() =>
      advance(checkpoint(), [declaration, { ...declaration, ...changed }]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });
  it('rejects observations for an unknown invocation', () => {
    expect(() =>
      advance(checkpoint(), [
        { kind: 'outcome', invocationKey: 'missing', status: 'failed' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('validates branch selection through persisted public checkpoint state', () => {
    const succeeded = {
      ...checkpoint(),
      invocations: [
        {
          invocationKey: 'condition',
          nodeId: 'condition',
          status: 'succeeded' as const,
          attemptNumber: 1,
          output: inline(ATTEMPT_ID),
        },
      ],
    };
    const observation = {
      kind: 'branch_selected' as const,
      invocationKey: 'condition',
      nodeId: 'condition',
      selectedOutputPort: 'true',
    };
    expect(advance(succeeded, [observation]).checkpoint).toMatchObject({
      branchSelections: [
        {
          invocationKey: 'condition',
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    });
    expect(() =>
      advance(
        {
          ...succeeded,
          branchSelections: [
            {
              invocationKey: 'condition',
              nodeId: 'condition',
              selectedOutputPort: 'false',
            },
          ],
        },
        [observation],
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
});
