import { describe, expect, it } from 'vitest';

import {
  createCheckpoint,
  parseCheckpoint,
  type WorkflowCheckpointV1,
} from '../src/index.js';
import {
  advanceWorkflow as advanceWorkflowForTesting,
  parseSchedulerGraph,
  type AdvanceWorkflowInput,
  type SchedulerGraph,
} from '../src/testing.js';

const occurredAt = '2026-08-20T10:00:00.000Z';
const chainGraph = {
  schemaVersion: 1,
  settings: {},
  nodes: ['a', 'b'].map((id) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  })),
  edges: [
    {
      id: 'a-b',
      source: { nodeId: 'a', port: 'output' },
      target: { nodeId: 'b', port: 'input' },
    },
  ],
} as const;

function checkpoint(): WorkflowCheckpointV1 {
  return createCheckpoint({
    engineVersion: 'engine-v1',
    workflowVersionId: 'version-1',
    iterationBudget: 1_000,
  });
}

function explicitSchedulerState(input: AdvanceWorkflowInput): SchedulerGraph {
  if (input.schedulerState !== undefined) return input.schedulerState;
  if (input.graph !== undefined) return parseSchedulerGraph(input.graph);
  const parsed = parseCheckpoint(input.checkpoint);
  const nodeIds = new Set(parsed.invocations.map(({ nodeId }) => nodeId));
  for (const observation of input.observations ?? []) {
    if (observation.kind === 'ready') nodeIds.add(observation.nodeId);
    else if (observation.kind === 'join_declared')
      nodeIds.add(observation.joinId);
    else if (
      observation.kind === 'loop_started' ||
      observation.kind === 'loop_iteration_completed'
    )
      nodeIds.add(observation.loopId);
  }
  return {
    deriveReadiness: false,
    nodes: [...nodeIds].map((id) => ({ id, sideEffectClass: 'safe' })),
    edges: [],
  };
}

function advanceWorkflow(input: AdvanceWorkflowInput) {
  const schedulerState = explicitSchedulerState(input);
  const { graph: _, ...withoutGraph } = input;
  void _;
  return advanceWorkflowForTesting({ ...withoutGraph, schedulerState });
}

describe('AdvanceWorkflow transitions', () => {
  it('fails closed on malformed scheduler graph input', () => {
    const accessorNode = { id: 'a' } as Record<string, unknown>;
    Object.defineProperty(accessorNode, 'disabled', {
      enumerable: true,
      get: () => false,
    });
    expect(() =>
      advanceWorkflow({
        checkpoint: checkpoint(),
        graph: { nodes: [accessorNode], edges: [] },
        occurredAt,
        maximumAdmissions: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'graph_invalid' }));
    expect(() =>
      advanceWorkflow({
        checkpoint: checkpoint(),
        graph: {
          nodes: [{ id: 'a' }],
          edges: [{ source: { nodeId: 'missing' }, target: { nodeId: 'a' } }],
        },
        occurredAt,
        maximumAdmissions: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'graph_invalid' }));
  });

  it('derives a successor in the same transition that consumes its prerequisite outcome', () => {
    const root = advanceWorkflow({
      checkpoint: checkpoint(),
      graph: chainGraph,
      occurredAt,
      maximumAdmissions: 1,
    });
    expect(root.attempts.map(({ nodeId }) => nodeId)).toEqual(['a']);
    const rootKey = root.checkpoint.invocations[0]?.invocationKey;
    if (rootKey === undefined) throw new Error('expected root invocation');
    const completed = advanceWorkflow({
      checkpoint: root.checkpoint,
      graph: chainGraph,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        { kind: 'outcome', invocationKey: rootKey, status: 'succeeded' },
      ],
    });
    expect(completed.attempts.map(({ nodeId }) => nodeId)).toEqual(['b']);
  });

  it('is deterministic across pre-commit recomputation and admits in canonical order', () => {
    const input = {
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 2,
      observations: [
        { kind: 'ready', invocationKey: 'z-key', nodeId: 'z' },
        { kind: 'ready', invocationKey: 'a-key', nodeId: 'a' },
        { kind: 'ready', invocationKey: 'm-key', nodeId: 'm' },
      ],
    } as const;
    const first = advanceWorkflow(input);
    expect(advanceWorkflow(input)).toEqual(first);
    expect(first.expectedRevision).toBe(0);
    expect(first.attempts.map(({ invocationKey }) => invocationKey)).toEqual([
      'a-key',
      'm-key',
    ]);
    expect(first.checkpoint.readySet).toEqual(['z-key']);
    expect(first.events.map(({ sequence }) => sequence)).toEqual([2, 3, 4, 5]);
  });

  it('makes a post-commit duplicate a no-op for logical attempt creation', () => {
    const committed = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [{ kind: 'ready', invocationKey: 'task', nodeId: 'task' }],
    });
    const duplicate = advanceWorkflow({
      checkpoint: committed.checkpoint,
      occurredAt,
      maximumAdmissions: 1,
      observations: [{ kind: 'ready', invocationKey: 'task', nodeId: 'task' }],
    });
    expect(duplicate.attempts).toEqual([]);
    expect(duplicate.checkpoint.invocations).toHaveLength(1);
  });

  it('makes exact duplicate outcomes idempotent and rejects conflicting outcomes', () => {
    const running = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [{ kind: 'ready', invocationKey: 'task', nodeId: 'task' }],
    });
    const output = {
      kind: 'artifact',
      artifactId: '00000000-0000-4000-8000-000000000101',
    } as const;
    const completed = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'outcome',
          invocationKey: 'task',
          status: 'succeeded',
          output,
        },
      ],
    });
    const duplicate = advanceWorkflow({
      checkpoint: completed.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'outcome',
          invocationKey: 'task',
          status: 'succeeded',
          output,
        },
      ],
    });

    expect(duplicate.events).toEqual([]);
    expect(duplicate.checkpoint.invocations).toEqual(
      completed.checkpoint.invocations,
    );
    expect(() =>
      advanceWorkflow({
        checkpoint: completed.checkpoint,
        occurredAt,
        maximumAdmissions: 0,
        observations: [
          {
            kind: 'outcome',
            invocationKey: 'task',
            status: 'failed',
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'transition_invalid' }));
    expect(() =>
      advanceWorkflow({
        checkpoint: completed.checkpoint,
        occurredAt,
        maximumAdmissions: 0,
        observations: [
          {
            kind: 'outcome',
            invocationKey: 'task',
            status: 'succeeded',
            output: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000102',
            },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'transition_invalid' }));
  });

  it('persists waits without a slot and resumes from the checkpoint', () => {
    const running = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [{ kind: 'ready', invocationKey: 'wait', nodeId: 'wait' }],
    });
    const waiting = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'wait',
          waitKind: 'node_wait',
          invocationKey: 'wait',
          resumeAt: '2026-08-21T10:00:00.000Z',
        },
      ],
    });
    expect(waiting.checkpoint.runStatus).toBe('waiting');
    expect(waiting.attempts).toEqual([]);
    const resumed = advanceWorkflow({
      checkpoint: waiting.checkpoint,
      occurredAt: '2026-08-21T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [{ kind: 'resume', invocationKey: 'wait' }],
    });
    expect(resumed.checkpoint.runStatus).toBe('running');
    expect(resumed.attempts).toEqual([
      {
        admissionKind: 'wait_resume',
        invocationKey: 'wait',
        nodeId: 'wait',
        attemptNumber: 2,
        sideEffectClass: 'safe',
      },
    ]);
  });

  it('stops admissions after cancellation and gives unknown outcomes precedence', () => {
    const running = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        { kind: 'ready', invocationKey: 'unsafe', nodeId: 'unsafe' },
      ],
    });
    const canceled = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 10,
      observations: [
        { kind: 'cancel_requested' },
        { kind: 'ready', invocationKey: 'later', nodeId: 'later' },
        { kind: 'outcome', invocationKey: 'unsafe', status: 'outcome_unknown' },
      ],
    });
    expect(canceled.attempts).toEqual([]);
    expect(canceled.checkpoint.runStatus).toBe('outcome_unknown');
    expect(
      canceled.checkpoint.invocations.some(
        ({ invocationKey }) => invocationKey === 'later',
      ),
    ).toBe(false);
  });

  it('does not admit already-ready work when cancellation is observed', () => {
    const ready = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        { kind: 'ready', invocationKey: 'later', nodeId: 'later' },
      ],
    });
    const canceled = advanceWorkflow({
      checkpoint: ready.checkpoint,
      occurredAt,
      maximumAdmissions: 1,
      observations: [{ kind: 'cancel_requested' }],
    });

    expect(canceled.attempts).toEqual([]);
    expect(canceled.checkpoint.invocations).toEqual([
      expect.objectContaining({ invocationKey: 'later', status: 'canceled' }),
    ]);
    expect(canceled.checkpoint.runStatus).toBe('canceled');
  });

  it.each([
    ['canceled', 'canceled'],
    ['timed_out', 'timed_out'],
    ['failed', 'failed'],
    ['outcome_unknown', 'outcome_unknown'],
  ] as const)(
    'derives run %s from a terminal node outcome',
    (nodeStatus, runStatus) => {
      const running = advanceWorkflow({
        checkpoint: checkpoint(),
        occurredAt,
        maximumAdmissions: 1,
        observations: [
          { kind: 'ready', invocationKey: 'node', nodeId: 'node' },
        ],
      });
      const terminal = advanceWorkflow({
        checkpoint: running.checkpoint,
        occurredAt,
        maximumAdmissions: 0,
        observations: [
          { kind: 'outcome', invocationKey: 'node', status: nodeStatus },
        ],
      });

      expect(terminal.checkpoint.runStatus).toBe(runStatus);
    },
  );

  it('marks a mixed succeeded and waiting run as waiting', () => {
    const running = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 2,
      observations: [
        { kind: 'ready', invocationKey: 'done', nodeId: 'done' },
        { kind: 'ready', invocationKey: 'wait', nodeId: 'wait' },
      ],
    });
    const waiting = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        { kind: 'outcome', invocationKey: 'done', status: 'succeeded' },
        {
          kind: 'wait',
          waitKind: 'node_wait',
          invocationKey: 'wait',
          resumeAt: '2026-08-21T10:00:00.000Z',
        },
      ],
    });

    expect(waiting.checkpoint.runStatus).toBe('waiting');
  });

  it('settles joins and persists canonical selection through advancement', () => {
    const settled = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'join_declared',
          joinId: 'join',
          policy: { kind: 'any' },
          branchIds: ['b', 'a'],
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          branch: { branchId: 'b', disposition: 'arrived' },
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          branch: { branchId: 'a', disposition: 'arrived' },
        },
      ],
    });

    expect(settled.checkpoint.joins).toEqual([
      expect.objectContaining({
        joinId: 'join',
        policy: { kind: 'any' },
        ledger: [
          { branchId: 'a', disposition: 'arrived' },
          { branchId: 'b', disposition: 'arrived' },
        ],
        selectedBranchIds: ['a'],
      }),
    ]);
    expect(settled.attempts).toEqual([
      expect.objectContaining({ nodeId: 'join', attemptNumber: 1 }),
    ]);
    const duplicate = advanceWorkflow({
      checkpoint: settled.checkpoint,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'branch_disposition',
          joinId: 'join',
          branch: { branchId: 'b', disposition: 'arrived' },
        },
      ],
    });
    expect(duplicate.checkpoint.joins[0]?.selectedBranchIds).toEqual(['a']);
    expect(duplicate.attempts).toEqual([]);
  });

  it('persists an unsatisfied join as a typed terminal failure', () => {
    const failed = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'join_declared',
          joinId: 'join',
          policy: { kind: 'count', count: 2 },
          branchIds: ['a', 'b'],
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          branch: { branchId: 'a', disposition: 'arrived' },
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          branch: { branchId: 'b', disposition: 'missing' },
        },
      ],
    });

    expect(failed.attempts).toEqual([]);
    expect(failed.checkpoint.joins[0]).toMatchObject({
      unsatisfiedReasonCode: 'insufficient_arrivals',
    });
    expect(failed.checkpoint.runStatus).toBe('failed');
  });
});
