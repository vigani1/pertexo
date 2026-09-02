import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  createCheckpoint,
  createCheckpointV2,
  invocationKey,
  type WorkflowCheckpoint,
  type WorkflowObservation,
} from '../src/testing.js';

const occurredAt = '2026-08-20T10:00:00.000Z';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const inline = (attemptId: string) => ({ kind: 'inline' as const, attemptId });

function advance(
  checkpoint: WorkflowCheckpoint,
  observations: readonly WorkflowObservation[],
  dueResumptions?: readonly Readonly<{
    invocationKey: string;
    occurredAt: string;
  }>[],
) {
  return advanceWorkflow({
    checkpoint,
    observations,
    occurredAt,
    maximumAdmissions: 0,
    ...(dueResumptions === undefined ? {} : { dueResumptions }),
  });
}

function checkpoint(): ReturnType<typeof createCheckpointV2> {
  return createCheckpointV2({
    engineVersion: 'engine-v2',
    workflowVersionId: 'version-1',
    iterationBudget: 100,
  });
}

describe('workflow transition public risk behavior', () => {
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
      advance(checkpoint(), [{ kind: 'join_declared', ...observation }]),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });

  it('accepts an idempotent join declaration and rejects a conflicting replay', () => {
    const declaration = {
      kind: 'join_declared' as const,
      joinId: 'join',
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

  it('rejects a disposition for an undeclared join', () => {
    expect(() =>
      advance(checkpoint(), [
        {
          kind: 'branch_disposition',
          joinId: 'missing',
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
        branchIds: ['a'],
        policy: { kind: 'all' },
      },
      {
        kind: 'loop_started',
        loopId: 'loop',
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
    { controlInvocationKey: 'scoped' },
    { branchPath: [] },
    { iterationPath: [] },
    { bodyRootNodeIds: ['body'] },
    { bodySinkNodeId: 'body' },
  ])('rejects structured loop state in a V1 checkpoint %#', (field) => {
    expect(() =>
      advance(
        createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: 'version-1',
          iterationBudget: 100,
        }),
        [
          {
            kind: 'loop_started',
            loopId: 'loop',
            collection: inline(ATTEMPT_ID),
            collectionChecksum: 'sum',
            collectionSize: 1,
            maxConcurrency: 1,
            maxIterations: 1,
            ...field,
          },
        ],
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
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

  it('rejects branch selection without an output-bearing matching invocation', () => {
    expect(() =>
      advance(checkpoint(), [
        {
          kind: 'branch_selected',
          invocationKey: 'missing',
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('rejects unknown due resumptions and suppresses them after cancellation', () => {
    const due = [{ invocationKey: 'missing', occurredAt }];
    expect(() => advance(checkpoint(), [], due)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(
      advance(checkpoint(), [{ kind: 'cancel_requested' }], due).checkpoint
        .cancelRequested,
    ).toBe(true);
  });

  it('orders every public observation family before applying terminal control', () => {
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
        invocationKey: 'condition',
        nodeId: 'condition',
        selectedOutputPort: 'true',
      },
      {
        kind: 'loop_started',
        loopId: 'loop',
        collection: inline(ATTEMPT_ID),
        collectionChecksum: 'sum',
        collectionSize: 0,
        maxConcurrency: 1,
        maxIterations: 1,
      },
      { kind: 'loop_iteration_completed', loopId: 'loop', ordinal: 0 },
      { kind: 'ready', invocationKey: 'ready', nodeId: 'ready' },
    ];

    expect(() => advance(checkpoint(), observations)).toThrow(
      expect.objectContaining({ code: 'join_invalid' }),
    );
  });

  it('accepts an identical terminal loop replay through checkpoint state', () => {
    const iterationInvocationKey = invocationKey({
      workflowVersionId: 'version-1',
      nodeId: 'body',
      branchPath: [],
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    });
    const iteration = {
      invocationKey: iterationInvocationKey,
      nodeId: 'body',
      status: 'succeeded' as const,
      attemptNumber: 1,
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
      output: inline(ATTEMPT_ID),
    };
    const persisted = {
      ...checkpoint(),
      remainingIterationBudget: 99,
      invocations: [
        {
          invocationKey: 'loop-control',
          nodeId: 'loop',
          status: 'succeeded' as const,
          attemptNumber: 1,
        },
        iteration,
      ],
      loops: [
        {
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
          nextOrdinal: 1,
          activeOrdinals: [],
          terminalOrdinals: [0],
        },
      ],
    };

    expect(
      advance(persisted, [
        {
          kind: 'loop_iteration_completed',
          loopId: 'loop',
          controlInvocationKey: 'loop-control',
          invocationKey: iterationInvocationKey,
          ordinal: 0,
          status: 'succeeded',
          output: inline(ATTEMPT_ID),
        },
      ]).checkpoint.invocations,
    ).toContainEqual(expect.objectContaining(iteration));

    expect(
      advance(persisted, [
        {
          kind: 'loop_iteration_completed',
          loopId: 'loop',
          controlInvocationKey: 'loop-control',
          invocationKey: iterationInvocationKey,
          ordinal: 0,
          output: inline(ATTEMPT_ID),
        },
      ]).checkpoint.invocations,
    ).toContainEqual(expect.objectContaining(iteration));

    expect(() =>
      advance(persisted, [
        {
          kind: 'loop_iteration_completed',
          loopId: 'loop',
          controlInvocationKey: 'loop-control',
          ordinal: 1,
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });

  it('rejects branch selection against a V1 checkpoint', () => {
    expect(() =>
      advance(
        createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: 'version-1',
          iterationBudget: 100,
        }),
        [
          {
            kind: 'branch_selected',
            invocationKey: 'condition',
            nodeId: 'condition',
            selectedOutputPort: 'true',
          },
        ],
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('rejects a loop declaration whose existing control is not running', () => {
    const persisted = {
      ...checkpoint(),
      invocations: [
        {
          invocationKey: 'loop-control',
          nodeId: 'loop',
          status: 'pending' as const,
          attemptNumber: 0,
        },
      ],
    };
    expect(() =>
      advance(persisted, [
        {
          kind: 'loop_started',
          loopId: 'loop',
          controlInvocationKey: 'loop-control',
          collection: inline(ATTEMPT_ID),
          collectionChecksum: 'sum',
          collectionSize: 1,
          maxConcurrency: 1,
          maxIterations: 1,
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });

  it('rejects completion for an undeclared loop', () => {
    expect(() =>
      advance(checkpoint(), [
        { kind: 'loop_iteration_completed', loopId: 'missing', ordinal: 0 },
      ]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });
});
