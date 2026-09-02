import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  createCheckpoint,
  createCheckpointV2,
  type WorkflowCheckpoint,
  type WorkflowObservation,
} from '../src/testing.js';

const occurredAt = '2026-08-20T10:00:00.000Z';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const inline = (attemptId: string) => ({ kind: 'inline' as const, attemptId });

function advance(
  checkpoint: WorkflowCheckpoint,
  observations: readonly WorkflowObservation[],
) {
  return advanceWorkflow({
    checkpoint,
    observations,
    occurredAt,
    maximumAdmissions: 0,
  });
}

function checkpoint(): WorkflowCheckpoint {
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
});
