import { describe, expect, it } from 'vitest';

import { createCheckpointV2, type WorkflowCheckpoint } from '../src/index.js';
import { applyWorkflowObservations } from '../src/workflow-transition-observations.js';
import {
  assertLoopInvocations,
  declaredJoin,
  observationOrder,
  sameOutputReference,
  schedulerNodeDisabled,
  schedulerNodeSideEffectClass,
  type MutableWorkflowTransition,
} from '../src/workflow-transition-state.js';
import type {
  InvocationState,
  LoopState,
  WorkflowObservation,
} from '../src/types.js';

const occurredAt = '2026-08-20T10:00:00.000Z';

function checkpoint(): WorkflowCheckpoint {
  return createCheckpointV2({
    engineVersion: 'engine-v2',
    workflowVersionId: 'version-1',
    iterationBudget: 100,
  });
}

function transitionState(
  input: Readonly<{
    checkpoint?: WorkflowCheckpoint;
    invocations?: readonly InvocationState[];
    externalFactsArePersisted?: boolean;
    cancelRequested?: boolean;
    deadlineExpired?: boolean;
  }> = {},
): MutableWorkflowTransition {
  const current = input.checkpoint ?? checkpoint();
  const invocations = input.invocations ?? current.invocations;
  return {
    current,
    graph: undefined,
    invocations: new Map(invocations.map((item) => [item.invocationKey, item])),
    joins: new Map(),
    loops: new Map(),
    branchSelections: [],
    remainingIterationBudget: current.remainingIterationBudget,
    eventDrafts: [],
    nodeRunAdmissionKeys: new Set(),
    externalFactsArePersisted: input.externalFactsArePersisted ?? false,
    cancelRequested: input.cancelRequested ?? false,
    deadlineExpired: input.deadlineExpired ?? false,
    deadlineOccurredAt: undefined,
    runStatus: current.runStatus,
  };
}

function apply(
  state: MutableWorkflowTransition,
  observations: readonly WorkflowObservation[],
  dueResumptions: readonly Readonly<{
    invocationKey: string;
    occurredAt: string;
  }>[] = [],
): void {
  applyWorkflowObservations(state, {
    observations,
    dueResumptions,
    occurredAt,
  });
}

const inline = (attemptId: string) => ({ kind: 'inline' as const, attemptId });
const artifact = (artifactId: string) => ({
  kind: 'artifact' as const,
  artifactId,
});

function loopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: 'loop',
    controlInvocationKey: 'loop-control',
    branchPath: [],
    iterationPath: [],
    bodyRootNodeIds: ['body'],
    bodySinkNodeId: 'body',
    collection: inline('collection'),
    collectionChecksum: 'sum',
    collectionSize: 1,
    maxConcurrency: 1,
    maxIterations: 1,
    nextOrdinal: 1,
    activeOrdinals: [0],
    terminalOrdinals: [],
    ...overrides,
  };
}

describe('workflow transition risk branches', () => {
  it('compares every output-reference shape', () => {
    expect(sameOutputReference(undefined, undefined)).toBe(true);
    expect(sameOutputReference(inline('a'), artifact('a'))).toBe(false);
    expect(sameOutputReference(inline('a'), inline('a'))).toBe(true);
    expect(sameOutputReference(inline('a'), inline('b'))).toBe(false);
    expect(sameOutputReference(artifact('a'), artifact('a'))).toBe(true);
    expect(sameOutputReference(artifact('a'), artifact('b'))).toBe(false);
  });

  it('deterministically orders every observation family and tied invocation facts', () => {
    const observations: WorkflowObservation[] = [
      { kind: 'cursor_only' },
      { kind: 'cancel_requested' },
      { kind: 'deadline_expired' },
      {
        kind: 'join_declared',
        joinId: 'join',
        branchIds: ['a'],
        policy: { kind: 'all' },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join',
        branch: { branchId: 'a', disposition: 'arrived' },
      },
      {
        kind: 'branch_selected',
        invocationKey: 'same',
        nodeId: 'a',
        selectedOutputPort: 'true',
      },
      {
        kind: 'loop_started',
        loopId: 'loop',
        collection: inline('a'),
        collectionChecksum: 'sum',
        collectionSize: 0,
        maxConcurrency: 1,
        maxIterations: 1,
      },
      { kind: 'loop_iteration_completed', loopId: 'loop', ordinal: 0 },
      { kind: 'ready', invocationKey: 'same', nodeId: 'a' },
      {
        kind: 'wait',
        invocationKey: 'same',
        resumeAt: occurredAt,
        waitKind: 'node_wait',
      },
    ];
    expect([...observations].sort(observationOrder)).toHaveLength(
      observations.length,
    );
    const ready = observations[8];
    const wait = observations[9];
    if (ready === undefined || wait === undefined)
      throw new Error('expected tied invocation observations');
    expect(observationOrder(ready, wait)).not.toBe(0);
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
      declaredJoin({ kind: 'join_declared', ...observation }),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });

  it('defaults and preserves join scope', () => {
    expect(
      declaredJoin({
        kind: 'join_declared',
        joinId: 'join',
        branchIds: ['a'],
        policy: { kind: 'all' },
      }),
    ).toMatchObject({
      joinInvocationKey: 'join',
      branchPath: [],
      iterationPath: [],
    });
    expect(
      declaredJoin({
        kind: 'join_declared',
        joinId: 'join',
        joinInvocationKey: 'scoped',
        branchIds: ['a'],
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        policy: { kind: 'count', count: 1 },
      }),
    ).toMatchObject({ joinInvocationKey: 'scoped' });
  });

  it('fails closed when scheduler admission state or a node is missing', () => {
    expect(() => schedulerNodeSideEffectClass(undefined, 'node')).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(() =>
      schedulerNodeSideEffectClass(
        { deriveReadiness: false, nodes: [], edges: [] },
        'node',
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(schedulerNodeDisabled(undefined, 'node')).toBe(false);
  });

  it('finds nested scheduler nodes and their disabled state', () => {
    const graph = {
      deriveReadiness: false,
      nodes: [],
      edges: [],
      structuredBodies: [
        {
          loopNodeId: 'loop',
          deriveReadiness: false,
          nodes: [
            {
              id: 'nested',
              sideEffectClass: 'unsafe' as const,
              disabled: true,
            },
          ],
          edges: [],
        },
      ],
    };
    expect(schedulerNodeSideEffectClass(graph, 'nested')).toBe('unsafe');
    expect(schedulerNodeDisabled(graph, 'nested')).toBe(true);
    expect(schedulerNodeDisabled(graph, 'missing')).toBe(false);
  });

  it('ignores new admissions and declarations after cancellation', () => {
    const state = transitionState({ cancelRequested: true });
    apply(state, [
      { kind: 'ready', invocationKey: 'ready', nodeId: 'ready' },
      {
        kind: 'join_declared',
        joinId: 'join',
        branchIds: ['a'],
        policy: { kind: 'all' },
      },
      {
        kind: 'loop_started',
        loopId: 'loop',
        collection: inline('a'),
        collectionChecksum: 'sum',
        collectionSize: 0,
        maxConcurrency: 1,
        maxIterations: 1,
      },
    ]);
    expect(state.invocations).toHaveLength(0);
    expect(state.joins).toHaveLength(0);
    expect(state.loops).toHaveLength(0);
  });

  it('accepts an idempotent join declaration and rejects a conflicting replay', () => {
    const state = transitionState();
    const declaration = {
      kind: 'join_declared' as const,
      joinId: 'join',
      branchIds: ['a'],
      policy: { kind: 'all' as const },
    };
    apply(state, [declaration, declaration]);
    expect(state.joins).toHaveLength(1);
    expect(() => {
      apply(state, [{ ...declaration, branchIds: ['b'] }]);
    }).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });

  it('rejects a disposition for an undeclared join', () => {
    expect(() => {
      apply(transitionState(), [
        {
          kind: 'branch_disposition',
          joinId: 'missing',
          branch: { branchId: 'a', disposition: 'arrived' },
        },
      ]);
    }).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });

  it('rejects branch selections for V1, missing outcomes, and conflicting replay', () => {
    const observation = {
      kind: 'branch_selected' as const,
      invocationKey: 'condition',
      nodeId: 'condition',
      selectedOutputPort: 'true',
    };
    const v1 = transitionState({
      checkpoint: {
        ...checkpoint(),
        schemaVersion: 1,
        branchSelections: undefined,
      } as unknown as WorkflowCheckpoint,
    });
    expect(() => {
      apply(v1, [observation]);
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() => {
      apply(transitionState(), [observation]);
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    const state = transitionState({
      invocations: [
        {
          invocationKey: 'condition',
          nodeId: 'condition',
          status: 'succeeded',
          attemptNumber: 1,
          output: inline('a'),
        },
      ],
    });
    apply(state, [observation, observation]);
    expect(() => {
      apply(state, [{ ...observation, selectedOutputPort: 'false' }]);
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('uses the supplied occurrence time when a deadline fact omits one', () => {
    const state = transitionState();
    apply(state, [{ kind: 'deadline_expired' }]);
    expect(state.deadlineOccurredAt).toBe(occurredAt);
  });

  it.each([
    { controlInvocationKey: 'scoped' },
    { branchPath: [] },
    { iterationPath: [] },
    { bodyRootNodeIds: ['body'] },
    { bodySinkNodeId: 'body' },
  ])('rejects each structured loop field on checkpoint V1 %#', (field) => {
    const v2 = createCheckpointV2({
      engineVersion: 'engine-v2',
      workflowVersionId: 'version-1',
      iterationBudget: 100,
    });
    const { branchSelections: _, initialIterationBudget: __, ...v1 } = v2;
    void _;
    void __;
    const state = transitionState({
      checkpoint: { ...v1, schemaVersion: 1 } as WorkflowCheckpoint,
    });
    expect(() => {
      apply(state, [
        {
          kind: 'loop_started',
          loopId: 'loop',
          collection: inline('collection'),
          collectionChecksum: 'sum',
          collectionSize: 1,
          maxConcurrency: 1,
          maxIterations: 1,
          ...field,
        },
      ]);
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('creates a missing loop control and rejects a non-running existing control', () => {
    const observation = {
      kind: 'loop_started' as const,
      loopId: 'loop',
      controlInvocationKey: 'loop-control',
      collection: inline('collection'),
      collectionChecksum: 'sum',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 1,
    };
    const created = transitionState();
    apply(created, [observation]);
    expect(created.invocations.get('loop-control')).toMatchObject({
      status: 'pending',
    });

    const invalid = transitionState({
      invocations: [
        {
          invocationKey: 'loop-control',
          nodeId: 'loop',
          status: 'pending',
          attemptNumber: 0,
        },
      ],
    });
    expect(() => {
      apply(invalid, [observation]);
    }).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });

  it('accepts an idempotent loop declaration and rejects a conflicting replay', () => {
    const observation = {
      kind: 'loop_started' as const,
      loopId: 'loop',
      controlInvocationKey: 'loop-control',
      collection: inline('collection'),
      collectionChecksum: 'sum',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 1,
    };
    const state = transitionState();
    apply(state, [observation, observation]);
    expect(() => {
      apply(state, [{ ...observation, collectionChecksum: 'different' }]);
    }).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });

  it('fails the running loop control when the iteration budget is exceeded', () => {
    const control: InvocationState = {
      invocationKey: 'loop-control',
      nodeId: 'loop',
      status: 'running',
      attemptNumber: 1,
    };
    const state = transitionState({ invocations: [control] });
    state.remainingIterationBudget = 0;
    apply(state, [
      {
        kind: 'loop_started',
        loopId: 'loop',
        controlInvocationKey: 'loop-control',
        collection: inline('collection'),
        collectionChecksum: 'sum',
        collectionSize: 1,
        maxConcurrency: 1,
        maxIterations: 1,
      },
    ]);
    expect(state.invocations.get('loop-control')).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects loop completion without its declaration or sink invocation', () => {
    const completion = {
      kind: 'loop_iteration_completed' as const,
      loopId: 'loop',
      controlInvocationKey: 'loop-control',
      invocationKey: 'body-0',
      ordinal: 0,
    };
    expect(() => {
      apply(transitionState(), [completion]);
    }).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
    const state = transitionState();
    state.loops.set('loop-control', loopState());
    expect(() => {
      apply(state, [completion]);
    }).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });

  it('accepts an identical terminal loop replay and rejects a conflicting one', () => {
    const succeeded: InvocationState = {
      invocationKey: 'body-0',
      nodeId: 'body',
      status: 'succeeded',
      attemptNumber: 1,
      output: inline('output'),
    };
    const state = transitionState({ invocations: [succeeded] });
    state.loops.set(
      'loop-control',
      loopState({ activeOrdinals: [], terminalOrdinals: [0] }),
    );
    const completion = {
      kind: 'loop_iteration_completed' as const,
      loopId: 'loop',
      controlInvocationKey: 'loop-control',
      invocationKey: 'body-0',
      ordinal: 0,
      status: 'succeeded' as const,
      output: inline('output'),
    };
    apply(state, [completion]);
    expect(() => {
      apply(state, [{ ...completion, status: 'failed' }]);
    }).toThrow(expect.objectContaining({ code: 'transition_invalid' }));
  });

  it('defaults loop completion to succeeded and preserves an omitted output', () => {
    const control: InvocationState = {
      invocationKey: 'loop-control',
      nodeId: 'loop',
      status: 'waiting',
      attemptNumber: 1,
    };
    const iteration: InvocationState = {
      invocationKey: 'body-0',
      nodeId: 'body',
      status: 'running',
      attemptNumber: 1,
    };
    const state = transitionState({ invocations: [control, iteration] });
    state.loops.set('loop-control', loopState());
    apply(state, [
      {
        kind: 'loop_iteration_completed',
        loopId: 'loop',
        controlInvocationKey: 'loop-control',
        invocationKey: 'body-0',
        ordinal: 0,
      },
    ]);
    expect(state.invocations.get('body-0')).toMatchObject({
      status: 'succeeded',
    });
  });

  it('rejects unknown invocation observations and due resumptions', () => {
    expect(() => {
      apply(transitionState(), [
        { kind: 'outcome', invocationKey: 'missing', status: 'failed' },
      ]);
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() => {
      apply(transitionState(), [], [{ invocationKey: 'missing', occurredAt }]);
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it.each([{ cancelRequested: true }, { deadlineExpired: true }])(
    'suppresses due resumptions under terminal control %#',
    (flags) => {
      const state = transitionState(flags);
      apply(state, [], [{ invocationKey: 'missing', occurredAt }]);
      expect(state.invocations).toHaveLength(0);
    },
  );

  it('validates missing active and terminal loop invocations', () => {
    const loop: LoopState = {
      loopId: 'loop',
      controlInvocationKey: 'loop',
      branchPath: [],
      iterationPath: [],
      bodyRootNodeIds: ['body'],
      bodySinkNodeId: 'body',
      collection: inline('a'),
      collectionChecksum: 'sum',
      collectionSize: 1,
      maxConcurrency: 1,
      maxIterations: 1,
      nextOrdinal: 1,
      activeOrdinals: [0],
      terminalOrdinals: [],
    };
    expect(() => {
      assertLoopInvocations('version-1', loop, new Map());
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() => {
      assertLoopInvocations(
        'version-1',
        { ...loop, activeOrdinals: [], terminalOrdinals: [0] },
        new Map(),
      );
    }).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
});
