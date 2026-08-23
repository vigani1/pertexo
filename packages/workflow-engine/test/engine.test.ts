import { describe, expect, it } from 'vitest';

import {
  admitLoopIterations,
  assertAttemptTransition,
  assertNodeTransition,
  assertRunTransition,
  completeLoopIteration,
  createCheckpoint,
  createLoopState,
  decideCancellation,
  decideRetry,
  invocationKey,
  parseCheckpoint,
  planDurableWait,
  providerIdempotencyKey,
  recordBranchDisposition,
  reconstructReadySet,
  settleJoin,
  WorkflowEngineError,
  type BranchLedgerEntry,
  type JoinPolicy,
  type WorkflowCheckpointV1,
  WORKFLOW_CHECKPOINT_LIMITS_V1,
} from '../src/index.js';
import {
  advanceWorkflow as advanceWorkflowForTesting,
  deriveReadyNodes,
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

describe('checkpoint seam', () => {
  it('defaults the additive retained deadline flag to false', () => {
    const { deadlineExpired: _, ...retained } = checkpoint();
    void _;
    expect(parseCheckpoint(retained).deadlineExpired).toBe(false);
    expect(checkpoint().deadlineExpired).toBe(false);
  });

  it('fails closed for an unsupported checkpoint version', () => {
    expect(() => parseCheckpoint({ schemaVersion: 2 })).toThrow(
      expect.objectContaining({ code: 'checkpoint_unsupported' }),
    );
  });

  it('canonicalizes collections and reconstructs ready work without transport state', () => {
    const parsed = parseCheckpoint({
      ...checkpoint(),
      readySet: ['z', 'a'],
      admittedInvocationKeys: ['z', 'a'],
      invocations: [
        { invocationKey: 'z', nodeId: 'z', status: 'ready', attemptNumber: 0 },
        { invocationKey: 'a', nodeId: 'a', status: 'ready', attemptNumber: 0 },
      ],
    });
    expect(parsed.readySet).toEqual(['a', 'z']);
    expect(
      parsed.invocations.map(({ invocationKey }) => invocationKey),
    ).toEqual(['a', 'z']);
    expect(reconstructReadySet(parsed)).toEqual(['a', 'z']);
  });

  it.each([
    [
      'invalid output reference',
      {
        invocations: [
          {
            invocationKey: 'done',
            nodeId: 'done',
            status: 'succeeded',
            attemptNumber: 1,
            output: { kind: 'inline', attemptId: 'not-a-uuid' },
          },
        ],
      },
    ],
    [
      'duplicate join IDs',
      {
        joins: [
          { joinId: 'join', policy: { kind: 'all' }, ledger: [] },
          { joinId: 'join', policy: { kind: 'all' }, ledger: [] },
        ],
      },
    ],
    [
      'inconsistent persisted join selection',
      {
        joins: [
          {
            joinId: 'join',
            policy: { kind: 'any' },
            ledger: [
              { branchId: 'a', disposition: 'arrived' },
              { branchId: 'b', disposition: 'arrived' },
            ],
            selectedBranchIds: ['b'],
          },
        ],
      },
    ],
    [
      'duplicate loop IDs',
      {
        loops: [
          {
            loopId: 'loop',
            collection: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000101',
            },
            collectionChecksum: 'sha256:a',
            collectionSize: 0,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 0,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
          {
            loopId: 'loop',
            collection: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000101',
            },
            collectionChecksum: 'sha256:a',
            collectionSize: 0,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 0,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
        ],
      },
    ],
    [
      'loop cursor gap',
      {
        loops: [
          {
            loopId: 'loop',
            collection: {
              kind: 'artifact',
              artifactId: '00000000-0000-4000-8000-000000000101',
            },
            collectionChecksum: 'sha256:a',
            collectionSize: 3,
            maxConcurrency: 1,
            maxIterations: 3,
            nextOrdinal: 2,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
        ],
      },
    ],
  ] as const)('fails closed on %s', (_label, change) => {
    expect(() => parseCheckpoint({ ...checkpoint(), ...change })).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });

  it('rejects oversized and accessor-backed checkpoint collections before traversal', () => {
    const oversized = {
      ...checkpoint(),
      readySet: Array.from(
        { length: 10_001 },
        (_, index) => `node-${String(index)}`,
      ),
    };
    expect(() => parseCheckpoint(oversized)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );

    const accessorBacked = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(accessorBacked, 'invocations', {
      enumerable: true,
      get: () => [],
    });
    expect(() => parseCheckpoint(accessorBacked)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );

    const hugeSparse: unknown[] = [];
    hugeSparse.length = 4_294_967_295;
    expect(() =>
      parseCheckpoint({ ...checkpoint(), invocations: hugeSparse }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('rejects non-JSON structure, unknown fields, and the byte-limit one-over', () => {
    expect(() =>
      parseCheckpoint({ ...checkpoint(), unexpected: true }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint(
        Object.assign(Object.create({ inherited: true }), checkpoint()),
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() =>
      parseCheckpoint({ ...checkpoint(), invocations: sparse }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...checkpoint(),
        engineVersion: 'x'.repeat(4 * 1_048_576),
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('accepts exact 256 KiB including escaped and surrogate string bytes', () => {
    const base = checkpoint();
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(JSON.stringify(base)).byteLength;
    const originalValueBytes = encoder.encode(
      JSON.stringify(base.engineVersion),
    ).byteLength;
    const escapedPrefix = '"\\\n\ud800😀';
    const escapedPrefixBytes = encoder.encode(
      JSON.stringify(escapedPrefix),
    ).byteLength;
    const requiredValueBytes =
      WORKFLOW_CHECKPOINT_LIMITS_V1.bytes - baseBytes + originalValueBytes;
    const exact = {
      ...base,
      engineVersion:
        escapedPrefix + 'x'.repeat(requiredValueBytes - escapedPrefixBytes),
    };
    expect(encoder.encode(JSON.stringify(exact)).byteLength).toBe(
      WORKFLOW_CHECKPOINT_LIMITS_V1.bytes,
    );
    expect(parseCheckpoint(exact).engineVersion).toBe(exact.engineVersion);
  });

  it('never invokes inherited toJSON while measuring checkpoint bytes', () => {
    let getterCalls = 0;
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() {
        getterCalls += 1;
        return () => checkpoint();
      },
    });
    try {
      expect(parseCheckpoint(checkpoint()).schemaVersion).toBe(1);
      expect(() =>
        parseCheckpoint({ ...checkpoint(), engineVersion: () => 'bad' }),
      ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
      expect(getterCalls).toBe(0);
    } finally {
      if (original === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', original);
    }
  });

  it('rejects hidden fields and accessors without invoking them', () => {
    let getterCalls = 0;
    const hiddenRequired = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(hiddenRequired, 'engineVersion', {
      enumerable: false,
      get: () => {
        getterCalls += 1;
        return 'engine-v1';
      },
    });
    expect(() => parseCheckpoint(hiddenRequired)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(getterCalls).toBe(0);

    const hiddenUnknown = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(hiddenUnknown, 'hidden', {
      enumerable: false,
      value: true,
    });
    expect(() => parseCheckpoint(hiddenUnknown)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });

  it('rejects top-level and nested proxies without running their traps', () => {
    let trapCalls = 0;
    const hostile = new Proxy(checkpoint(), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw new Error('proxy trap ran');
      },
      ownKeys: () => {
        trapCalls += 1;
        throw new Error('proxy trap ran');
      },
    });
    expect(() => parseCheckpoint(hostile)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    const nested = {
      ...checkpoint(),
      invocations: [
        new Proxy(
          {
            invocationKey: 'a',
            nodeId: 'a',
            status: 'ready',
            attemptNumber: 0,
          },
          {
            getOwnPropertyDescriptor: () => {
              trapCalls += 1;
              throw new Error('nested proxy trap ran');
            },
          },
        ),
      ],
      readySet: ['a'],
    };
    expect(() => parseCheckpoint(nested)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(trapCalls).toBe(0);
  });

  it('rejects a wide object at the incremental member cap', () => {
    const wide: Record<string, number> = {};
    for (
      let index = 0;
      index <= WORKFLOW_CHECKPOINT_LIMITS_V1.members;
      index += 1
    )
      wide[`field-${String(index)}`] = index;
    const startedAt = performance.now();
    expect(() =>
      parseCheckpoint({ ...checkpoint(), engineVersion: wide }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('AdvanceWorkflow operation', () => {
  it('rejects attempt admission without explicit scheduler state', () => {
    expect(() =>
      advanceWorkflowForTesting({
        checkpoint: checkpoint(),
        occurredAt,
        maximumAdmissions: 1,
        observations: [
          { kind: 'ready', invocationKey: 'node', nodeId: 'node' },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'scheduler state is required for attempt admission',
      }),
    );
  });

  it('uses ordinal node ordering for deterministic admissions', () => {
    expect(
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            { id: 'a', sideEffectClass: 'safe' },
            { id: 'Z', sideEffectClass: 'safe' },
          ],
          edges: [],
        },
        workflowVersionId: 'version-1',
        invocations: [],
      }).map(({ nodeId }) => nodeId),
    ).toEqual(['Z', 'a']);
  });

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
      {
        joinId: 'join',
        policy: { kind: 'any' },
        ledger: [
          { branchId: 'a', disposition: 'arrived' },
          { branchId: 'b', disposition: 'arrived' },
        ],
        selectedBranchIds: ['a'],
      },
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

  it('reconstructs bounded loop admission from the checkpoint', () => {
    const first = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'loop_started',
          loopId: 'loop',
          collection: {
            kind: 'artifact',
            artifactId: '00000000-0000-4000-8000-000000000101',
          },
          collectionChecksum: 'sha256:abc',
          collectionSize: 3,
          maxIterations: 3,
          maxConcurrency: 2,
        },
      ],
    });
    expect(first.checkpoint.loops).toEqual([
      expect.objectContaining({
        loopId: 'loop',
        nextOrdinal: 2,
        activeOrdinals: [0, 1],
        terminalOrdinals: [],
      }),
    ]);
    expect(first.attempts).toHaveLength(2);

    const reconstructed = advanceWorkflow({
      checkpoint: JSON.parse(
        JSON.stringify(first.checkpoint),
      ) as WorkflowCheckpointV1,
      occurredAt,
      maximumAdmissions: 10,
    });
    expect(reconstructed.attempts).toEqual([]);
    expect(reconstructed.checkpoint.loops).toEqual(first.checkpoint.loops);

    const continued = advanceWorkflow({
      checkpoint: first.checkpoint,
      occurredAt,
      maximumAdmissions: 10,
      observations: [
        { kind: 'loop_iteration_completed', loopId: 'loop', ordinal: 1 },
      ],
    });
    expect(continued.checkpoint.loops).toEqual([
      expect.objectContaining({
        nextOrdinal: 3,
        activeOrdinals: [0, 2],
        terminalOrdinals: [1],
      }),
    ]);
    expect(continued.attempts).toEqual([
      expect.objectContaining({ nodeId: 'loop', attemptNumber: 1 }),
    ]);
  });

  it('cancels ready loop iterations without admitting another batch', () => {
    const ready = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'loop_started',
          loopId: 'loop',
          collection: {
            kind: 'artifact',
            artifactId: '00000000-0000-4000-8000-000000000101',
          },
          collectionChecksum: 'sha256:abc',
          collectionSize: 3,
          maxIterations: 3,
          maxConcurrency: 2,
        },
      ],
    });
    const canceled = advanceWorkflow({
      checkpoint: ready.checkpoint,
      occurredAt,
      maximumAdmissions: 10,
      observations: [{ kind: 'cancel_requested' }],
    });

    expect(canceled.attempts).toEqual([]);
    expect(canceled.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 2,
      activeOrdinals: [],
      terminalOrdinals: [0, 1],
    });
    expect(canceled.checkpoint.runStatus).toBe('canceled');
  });

  it('holds graph successors until the persisted loop parent completes', () => {
    const first = advanceWorkflow({
      checkpoint: checkpoint(),
      graph: chainGraph,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'loop_started',
          loopId: 'a',
          collection: {
            kind: 'artifact',
            artifactId: '00000000-0000-4000-8000-000000000101',
          },
          collectionChecksum: 'sha256:abc',
          collectionSize: 1,
          maxIterations: 1,
          maxConcurrency: 1,
        },
      ],
    });
    expect(first.attempts.map(({ nodeId }) => nodeId)).toEqual(['a']);
    const completed = advanceWorkflow({
      checkpoint: first.checkpoint,
      graph: chainGraph,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        { kind: 'loop_iteration_completed', loopId: 'a', ordinal: 0 },
      ],
    });
    expect(completed.attempts).toEqual([]);
    const successor = advanceWorkflow({
      checkpoint: completed.checkpoint,
      graph: chainGraph,
      occurredAt,
      maximumAdmissions: 1,
    });
    expect(successor.attempts.map(({ nodeId }) => nodeId)).toEqual(['b']);
  });
});

describe('branch and join scheduling', () => {
  const ledger = (
    entries: readonly [string, BranchLedgerEntry['disposition']][],
  ) => entries.map(([branchId, disposition]) => ({ branchId, disposition }));
  const decide = (
    policy: JoinPolicy,
    entries: readonly [string, BranchLedgerEntry['disposition']][],
  ) => settleJoin({ joinId: 'join', policy, ledger: ledger(entries) });

  it('waits for explicit dispositions including skipped and missing branches', () => {
    expect(
      decide({ kind: 'any' }, [
        ['a', 'arrived'],
        ['b', 'pending'],
      ]),
    ).toEqual({ kind: 'waiting' });
  });

  it.each([
    [{ kind: 'all' } as const, ['a', 'b', 'c']],
    [{ kind: 'any' } as const, ['a']],
    [{ kind: 'count', count: 2 } as const, ['a', 'b']],
  ])('settles %j by canonical branch ID', (policy, selected) => {
    const result = decide(policy, [
      ['c', 'arrived'],
      ['b', 'arrived'],
      ['a', 'arrived'],
    ]);
    expect(result).toMatchObject({
      kind: 'satisfied',
      selectedBranchIds: selected,
    });
  });

  it('returns a typed unsatisfied result instead of waiting forever', () => {
    expect(
      decide({ kind: 'count', count: 2 }, [
        ['a', 'arrived'],
        ['b', 'missing'],
      ]),
    ).toMatchObject({
      kind: 'unsatisfied',
      reasonCode: 'insufficient_arrivals',
    });
  });

  it('lets all joins preserve explicit skipped and missing branches', () => {
    expect(
      decide({ kind: 'all' }, [
        ['a', 'arrived'],
        ['b', 'skipped'],
        ['c', 'missing'],
      ]),
    ).toMatchObject({ kind: 'satisfied', selectedBranchIds: ['a'] });
  });

  it('makes an exact duplicate branch fact idempotent and rejects conflicts', () => {
    const initial = ledger([
      ['b', 'pending'],
      ['a', 'pending'],
    ]);
    const arrived = recordBranchDisposition(initial, {
      branchId: 'a',
      disposition: 'arrived',
      output: {
        kind: 'artifact',
        artifactId: '00000000-0000-4000-8000-000000000101',
      },
    });
    const recorded = arrived.find(({ branchId }) => branchId === 'a');
    if (recorded === undefined) throw new Error('expected branch a');
    expect(recordBranchDisposition(arrived, recorded)).toEqual(arrived);
    expect(() =>
      recordBranchDisposition(arrived, {
        branchId: 'a',
        disposition: 'failed',
      }),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
  });
});

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

describe('retry, wait, cancellation, and transition policy', () => {
  const policy = {
    maximumAttempts: 3,
    baseDelayMs: 100,
    maximumDelayMs: 500,
    retryableErrorCodes: ['rate_limited', 'rate_limit', 'network'],
  } as const;

  it('uses bounded deterministic backoff and stable provider identity', () => {
    expect(
      decideRetry({
        sideEffectClass: 'idempotent_with_key',
        currentAttemptNumber: 2,
        policy,
        observation: { kind: 'definite_failure', errorCode: 'rate_limited' },
      }),
    ).toEqual({ kind: 'retry', attemptNumber: 3, delayMs: 200 });
    const input = {
      namespace: 'pertexo',
      runId: 'run',
      invocationKey: 'node',
      operationIdentity: 'http.post.v1',
    };
    expect(providerIdempotencyKey(input)).toBe(
      'v1.fc0b851d7fb6df8735e56d5cb8bb36956147162cdc1286601d755e33345c8fa1',
    );
    expect(
      providerIdempotencyKey({
        namespace: 'n'.repeat(1_000),
        runId: 'r'.repeat(1_000),
        invocationKey: 'i'.repeat(1_000),
        operationIdentity: 'o'.repeat(1_000),
      }),
    ).toHaveLength(67);
  });

  it('never retries an unsafe possibly dispatched ambiguous effect', () => {
    expect(
      decideRetry({
        sideEffectClass: 'unsafe',
        currentAttemptNumber: 1,
        policy,
        observation: { kind: 'ambiguous', possiblyDispatched: true },
      }),
    ).toEqual({
      kind: 'outcome_unknown',
      reasonCode: 'unsafe_possible_dispatch',
    });
  });

  it('applies adapter recommendations, attempt bounds, and deterministic jitter', () => {
    const input = {
      sideEffectClass: 'safe' as const,
      currentAttemptNumber: 1,
      policy,
      observation: {
        kind: 'executor_failure' as const,
        recommendation: 'retry' as const,
        errorKind: 'rate_limit' as const,
        possiblyDispatched: true,
      },
      jitterIdentity: 'run/invocation/1/engine.retry@1',
    };
    const first = decideRetry(input);
    expect(first).toEqual(decideRetry(input));
    expect(first).toMatchObject({ kind: 'retry', attemptNumber: 2 });
    if (first.kind !== 'retry') throw new Error('expected retry');
    expect(first.delayMs).toBeGreaterThanOrEqual(75);
    expect(first.delayMs).toBeLessThan(125);
    for (let index = 0; index < 100; index += 1) {
      const capped = decideRetry({
        ...input,
        currentAttemptNumber: 2,
        policy: { ...policy, baseDelayMs: 500, maximumDelayMs: 500 },
        jitterIdentity: `bounded-jitter-${String(index)}`,
      });
      if (capped.kind !== 'retry') throw new Error('expected bounded retry');
      expect(capped.delayMs).toBeLessThanOrEqual(500);
    }
    expect(
      decideRetry({
        ...input,
        currentAttemptNumber: 3,
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'rate_limit' });
    expect(
      decideRetry({
        ...input,
        observation: { ...input.observation, recommendation: 'failed' },
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'rate_limit' });
    expect(
      decideRetry({
        ...input,
        observation: {
          ...input.observation,
          errorKind: 'authentication',
        },
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'authentication' });
  });

  it.each(['safe', 'idempotent_with_key'] as const)(
    'retries possibly-dispatched ambiguity for %s work',
    (sideEffectClass) => {
      expect(
        decideRetry({
          sideEffectClass,
          currentAttemptNumber: 1,
          policy,
          observation: {
            kind: 'executor_failure',
            recommendation: 'outcome_unknown',
            errorKind: 'network',
            possiblyDispatched: true,
          },
        }),
      ).toMatchObject({ kind: 'retry', attemptNumber: 2 });
    },
  );

  it('models a durable wait as a released slot', () => {
    expect(
      planDurableWait({
        invocationKey: 'wait',
        resumeAt: '2026-08-21T00:00:00Z',
        now: occurredAt,
      }),
    ).toEqual({
      invocationKey: 'wait',
      transition: 'waiting',
      resumeAt: '2026-08-21T00:00:00Z',
      releasesWorkerSlot: true,
    });
  });

  it('requires cancellation reconciliation and preserves unsafe uncertainty', () => {
    expect(
      decideCancellation([
        {
          invocationKey: 'a',
          nodeId: 'a',
          status: 'running',
          attemptNumber: 1,
        },
      ]),
    ).toEqual({ kind: 'await_reconciliation', invocationKeys: ['a'] });
    expect(
      decideCancellation([
        {
          invocationKey: 'unsafe',
          nodeId: 'unsafe',
          status: 'running',
          attemptNumber: 1,
          possiblyDispatched: true,
          sideEffectClass: 'unsafe',
        },
      ]),
    ).toEqual({ kind: 'outcome_unknown', invocationKeys: ['unsafe'] });
  });

  it('rejects terminal resurrection in all state machines', () => {
    expect(() => {
      assertRunTransition('succeeded', 'running');
    }).toThrow(WorkflowEngineError);
    expect(() => {
      assertNodeTransition('failed', 'ready');
    }).toThrow(WorkflowEngineError);
    expect(() => {
      assertAttemptTransition('outcome_unknown', 'running');
    }).toThrow(WorkflowEngineError);
  });
});
