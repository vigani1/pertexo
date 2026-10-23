import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  invocationKey,
  type WorkflowObservation,
} from '../../support/engine.js';

import {
  occurredAt,
  ATTEMPT_ID,
  inline,
  advance,
  workflowVersionId,
  rootKey,
  loopBody,
  checkpoint,
} from '../../support/transition/invariants.js';

describe('workflow transition public risk behavior', () => {
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
  it('applies a join declaration before its same-window disposition', () => {
    const observations: WorkflowObservation[] = [
      {
        kind: 'branch_disposition',
        joinId: 'join',
        joinInvocationKey: rootKey('join'),
        branch: { branchId: 'a', disposition: 'arrived' },
      },
      {
        kind: 'join_declared',
        joinId: 'join',
        joinInvocationKey: rootKey('join'),
        branchIds: ['a'],
        policy: { kind: 'all' },
      },
    ];
    const plan = advanceWorkflow({
      checkpoint: checkpoint(),
      observations,
      occurredAt,
      maximumAdmissions: 0,
      schedulerState: {
        deriveReadiness: false,
        nodes: [{ id: 'join', sideEffectClass: 'safe' }],
        edges: [],
      },
    });
    expect(plan.checkpoint.joins[0]?.ledger).toEqual([
      { branchId: 'a', disposition: 'arrived' },
    ]);
  });
  it('accepts an identical terminal loop replay through checkpoint state', () => {
    const iterationInvocationKey = invocationKey({
      workflowVersionId,
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
          completedPrefix: 0,
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
    ).not.toContainEqual(expect.objectContaining(iteration));

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
    ).not.toContainEqual(expect.objectContaining(iteration));

    expect(() =>
      advance(persisted, [
        {
          kind: 'loop_iteration_completed',
          loopId: 'loop',
          controlInvocationKey: 'loop-control',
          invocationKey: 'missing-iteration',
          ordinal: 1,
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });
  it('accepts only an output-identical terminal invocation replay without another event', () => {
    const terminal = {
      ...checkpoint(),
      runStatus: 'succeeded' as const,
      invocations: [
        {
          invocationKey: 'completed-node',
          nodeId: 'completed-node',
          status: 'succeeded' as const,
          attemptNumber: 1,
          output: inline(ATTEMPT_ID),
        },
      ],
    };
    const replay = {
      kind: 'outcome' as const,
      invocationKey: 'completed-node',
      status: 'succeeded' as const,
      output: inline(ATTEMPT_ID),
    };

    const plan = advance(terminal, [replay]);
    expect(plan.checkpoint.invocations).toEqual(terminal.invocations);
    expect(plan.events).toEqual([]);

    expect(() =>
      advance(terminal, [
        { ...replay, output: inline('22222222-2222-4222-8222-222222222222') },
      ]),
    ).toThrow(expect.objectContaining({ code: 'transition_invalid' }));
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
          ...loopBody,
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
        {
          kind: 'loop_iteration_completed',
          loopId: 'missing',
          controlInvocationKey: rootKey('missing'),
          invocationKey: 'missing-iteration',
          ordinal: 0,
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'loop_state_invalid' }));
  });
});
