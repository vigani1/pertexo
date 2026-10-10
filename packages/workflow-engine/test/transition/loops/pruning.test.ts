import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  createCheckpoint,
  createLoopState,
  invocationKey,
  parseCheckpoint,
  type WorkflowCheckpoint,
  type WorkflowObservation,
  type SchedulerGraph,
} from '../../support/engine.js';
import type { InvocationState, LoopState } from '../../../src/types.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000001';
const occurredAt = '2026-10-10T12:00:00.000Z';
const collectionId = '00000000-0000-4000-8000-000000000002';
const outputId = '00000000-0000-4000-8000-000000000003';
const output = { kind: 'inline' as const, attemptId: outputId };
const key = (nodeId: string, ordinal?: number) =>
  invocationKey({
    workflowVersionId,
    nodeId,
    ...(ordinal === undefined
      ? {}
      : { iterationPath: [{ loopNodeId: 'loop', ordinal }] }),
  });

function body(
  nodeId: string,
  ordinal: number,
  status: InvocationState['status'],
): InvocationState {
  return {
    invocationKey: key(nodeId, ordinal),
    nodeId,
    status,
    attemptNumber: 1,
    branchPath: [],
    iterationPath: [{ loopNodeId: 'loop', ordinal }],
    ...(status === 'succeeded' ? { output } : {}),
    ...(status === 'waiting'
      ? { resumeAt: occurredAt, waitKind: 'node_wait' as const }
      : {}),
  };
}

function loop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    ...createLoopState({
      controlInvocationKey: key('loop'),
      loopId: 'loop',
      branchPath: [],
      iterationPath: [],
      bodyRootNodeIds: ['body'],
      bodySinkNodeId: 'body',
      collection: { kind: 'inline', attemptId: collectionId },
      collectionChecksum: 'collection',
      collectionSize: 3,
      maxConcurrency: 2,
      maxIterations: 3,
      remainingIterationBudget: 10,
    }),
    nextOrdinal: 2,
    activeOrdinals: [0, 1],
    ...overrides,
  };
}

function checkpoint(
  declared = loop(),
  bodies = [body('body', 0, 'running'), body('body', 1, 'running')],
  controlStatus: InvocationState['status'] = 'waiting',
): WorkflowCheckpoint {
  return {
    ...createCheckpoint({ workflowVersionId, iterationBudget: 10 }),
    runStatus: 'running',
    remainingIterationBudget: 10 - declared.collectionSize,
    invocations: [
      {
        invocationKey: key('loop'),
        nodeId: 'loop',
        status: controlStatus,
        attemptNumber: 1,
        output: declared.collection,
      },
      ...bodies,
    ],
    admittedInvocationKeys: [
      key('loop'),
      ...bodies.map(({ invocationKey }) => invocationKey),
    ],
    loops: [declared],
  };
}

const schedulerState: SchedulerGraph = {
  deriveReadiness: false,
  nodes: [{ id: 'loop', sideEffectClass: 'safe' }],
  edges: [],
  structuredBodies: [
    {
      loopNodeId: 'loop',
      nodes: ['body', 'owner', 'condition', 'join', 'inner'].map((id) => ({
        id,
        sideEffectClass: 'safe' as const,
      })),
      edges: [],
    },
  ],
};

function advance(
  current: WorkflowCheckpoint,
  observations: readonly WorkflowObservation[] = [],
  maximumAdmissions = 0,
) {
  return advanceWorkflow({
    checkpoint: parseCheckpoint(JSON.parse(JSON.stringify(current))),
    schedulerState,
    occurredAt,
    observations,
    maximumAdmissions,
  });
}

const completion = (ordinal: number): WorkflowObservation => ({
  kind: 'loop_iteration_completed',
  loopId: 'loop',
  controlInvocationKey: key('loop'),
  invocationKey: key('body', ordinal),
  ordinal,
  status: 'succeeded',
  output,
  coordinatorDerived: true,
});

describe('finished iteration ownership', () => {
  it('prunes an out-of-order completion, recovers its frontier and never admits its keys again', () => {
    const later = advance(checkpoint(), [completion(1)]);
    expect(later.checkpoint.loops[0]).toMatchObject({
      completedPrefix: 0,
      terminalOrdinals: [1],
      activeOrdinals: [0, 2],
    });
    expect(
      later.checkpoint.invocations.some(
        ({ invocationKey }) => invocationKey === key('body', 1),
      ),
    ).toBe(false);
    expect(later.checkpoint.admittedInvocationKeys).not.toContain(
      key('body', 1),
    );
    const earlier = advance(later.checkpoint, [completion(0)]);
    expect(earlier.checkpoint.loops[0]).toMatchObject({
      completedPrefix: 2,
      terminalOrdinals: [],
      activeOrdinals: [2],
    });
    const replay = advance(earlier.checkpoint, [
      completion(1),
      {
        kind: 'ready',
        nodeId: 'body',
        invocationKey: key('body', 1),
        iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
      },
    ]);
    expect(replay.checkpoint).toEqual({
      ...earlier.checkpoint,
      revision: earlier.checkpoint.revision + 1,
    });
    expect(replay.events).toEqual([]);
    expect(replay.nodeRunAdmissions).toEqual([]);
    expect(replay.attempts).toEqual([]);
    expect(replay.checkpoint.remainingIterationBudget).toBe(7);
  });

  it('retains a completed iteration while another owner waits, then prunes after that owner settles', () => {
    const declared = loop({
      collectionSize: 1,
      nextOrdinal: 1,
      activeOrdinals: [],
      terminalOrdinals: [0],
      terminalStatus: 'failed',
    });
    const current = checkpoint(
      declared,
      [body('body', 0, 'failed'), body('owner', 0, 'waiting')],
      'failed',
    );
    const waiting = advance(current);
    expect(waiting.checkpoint.invocations).toHaveLength(3);
    expect(waiting.checkpoint.loops[0]).toMatchObject({
      completedPrefix: 0,
      terminalOrdinals: [0],
    });
    const resumed = advance(
      waiting.checkpoint,
      [{ kind: 'resume', invocationKey: key('owner', 0) }],
      1,
    );
    expect(resumed.attempts).toHaveLength(1);
    const settled = advance(resumed.checkpoint, [
      { kind: 'outcome', invocationKey: key('owner', 0), status: 'canceled' },
    ]);
    expect(settled.checkpoint.runStatus).toBe('failed');
    expect(settled.checkpoint.loops[0]).toMatchObject({
      completedPrefix: 1,
      terminalOrdinals: [],
    });
    expect(settled.checkpoint.invocations.map(({ nodeId }) => nodeId)).toEqual([
      'loop',
    ]);
  });

  it('removes joins, branch selections and output references with their terminal scope', () => {
    const declared = loop({
      collectionSize: 1,
      nextOrdinal: 1,
      activeOrdinals: [],
      terminalOrdinals: [0],
    });
    const current: WorkflowCheckpoint = {
      ...checkpoint(
        declared,
        [
          body('body', 0, 'succeeded'),
          body('condition', 0, 'succeeded'),
          body('join', 0, 'succeeded'),
        ],
        'succeeded',
      ),
      branchSelections: [
        {
          invocationKey: key('condition', 0),
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
      joins: [
        {
          joinId: 'join',
          joinInvocationKey: key('join', 0),
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
          policy: { kind: 'all' },
          ledger: [{ branchId: 'a', disposition: 'arrived', output }],
          selectedBranchIds: ['a'],
        },
      ],
    };
    const pruned = advance(current);
    expect(pruned.checkpoint.joins).toEqual([]);
    expect(pruned.checkpoint.branchSelections).toEqual([]);
    expect(pruned.checkpoint.admittedInvocationKeys).toEqual([key('loop')]);
    expect(JSON.stringify(pruned.checkpoint)).not.toContain(outputId);
    expect(
      pruned.prunedInvocations?.map(({ nodeId }) => nodeId).sort(),
    ).toEqual(['body', 'condition', 'join']);
  });

  it('retires a nested declaration without refunding its reserved budget or retaining its keys', () => {
    const outer = loop({
      collectionSize: 1,
      nextOrdinal: 1,
      activeOrdinals: [],
      terminalOrdinals: [0],
    });
    const inner = {
      ...loop({
        controlInvocationKey: key('inner', 0),
        loopId: 'inner',
        collectionSize: 2,
        nextOrdinal: 2,
        completedPrefix: 2,
        activeOrdinals: [],
        terminalOrdinals: [],
      }),
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    };
    const current = {
      ...checkpoint(
        outer,
        [body('body', 0, 'succeeded'), body('inner', 0, 'succeeded')],
        'succeeded',
      ),
      loops: [outer, inner],
      remainingIterationBudget: 7,
    };
    const pruned = advance(current);
    expect(pruned.checkpoint.loops).toHaveLength(1);
    expect(pruned.checkpoint.retiredIterationBudget).toBe(2);
    expect(pruned.checkpoint.remainingIterationBudget).toBe(7);
    const recovered = parseCheckpoint(
      JSON.parse(JSON.stringify(pruned.checkpoint)),
    );
    expect(recovered).toEqual(pruned.checkpoint);
    expect(() =>
      parseCheckpoint({ ...recovered, retiredIterationBudget: 3 }),
    ).toThrow(/budget/u);
    expect(() =>
      parseCheckpoint({ ...recovered, remainingIterationBudget: 8 }),
    ).toThrow(/budget/u);
    const redeclared = advance(recovered, [
      {
        kind: 'loop_started',
        loopId: 'inner',
        controlInvocationKey: inner.controlInvocationKey,
        branchPath: [],
        iterationPath: inner.iterationPath,
        bodyRootNodeIds: ['body'],
        bodySinkNodeId: 'body',
        collection: inner.collection,
        collectionChecksum: inner.collectionChecksum,
        collectionSize: 2,
        maxConcurrency: 2,
        maxIterations: 3,
      },
    ]);
    expect(redeclared.nodeRunAdmissions).toEqual([]);
    expect(redeclared.checkpoint.remainingIterationBudget).toBe(7);
    expect(redeclared.checkpoint.loops).toHaveLength(1);
  });

  it.each([-1, 1.5, 3])(
    'rejects an impossible completion frontier %s',
    (completedPrefix) => {
      const current = checkpoint();
      expect(() =>
        parseCheckpoint({
          ...current,
          loops: [{ ...current.loops[0], completedPrefix }],
        }),
      ).toThrow();
    },
  );
});
