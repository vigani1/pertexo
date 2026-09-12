import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createCheckpointV2,
  invocationKey,
  nodeRelease,
  pairedParallelGraph,
  forEachGraph,
} from './executable-workflow.fixtures.js';
import { parseCheckpoint } from '../src/index.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000901';
const occurredAt = '2026-09-12T00:00:00.000Z';

function executable() {
  return buildWorkflowExecutableV2({
    graph: {
      schemaVersion: 1,
      settings: {},
      nodes: [
        {
          id: 'set',
          definition: { key: 'core.set', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
    },
    release: composeExecutableCompatibilityRelease(nodeRelease()),
  });
}

function baseCheckpoint() {
  return createCheckpoint({
    engineVersion: 'engine-v1',
    workflowVersionId,
    iterationBudget: 10,
  });
}

function serialized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function advanceInput(
  checkpoint: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    runId: 'serialized-boundary-run',
    executable: executable(),
    workflowVersionId,
    checkpoint,
    occurredAt,
    maximumAdmissions: 0,
    signal: new AbortController().signal,
    ...extra,
  };
}

describe('serialized workflow boundary matrices', () => {
  it.each([
    [
      'noncanonical invocation identity',
      (checkpoint: Record<string, unknown>) => {
        checkpoint.invocations = [
          {
            invocationKey: 'wrong',
            nodeId: 'set',
            status: 'pending',
            attemptNumber: 0,
          },
        ];
      },
      'workflow_identity_invalid',
      'checkpoint invocation does not belong to the executable graph',
    ],
    [
      'unknown admission identity',
      (checkpoint: Record<string, unknown>) => {
        checkpoint.admittedInvocationKeys = ['missing'];
      },
      'workflow_identity_invalid',
      'checkpoint admission does not belong to an executable invocation',
    ],
    [
      'join identity without a paired Merge',
      (checkpoint: Record<string, unknown>) => {
        const joinKey = invocationKey({ workflowVersionId, nodeId: 'set' });
        checkpoint.invocations = [
          {
            invocationKey: joinKey,
            nodeId: 'set',
            status: 'pending',
            attemptNumber: 0,
          },
        ];
        checkpoint.joins = [
          {
            joinId: 'set',
            policy: { kind: 'all' },
            ledger: [{ branchId: 'branch-01', disposition: 'pending' }],
          },
        ];
      },
      'workflow_identity_invalid',
      'checkpoint join does not belong to a Merge node',
    ],
    [
      'loop identity without a For Each',
      (checkpoint: Record<string, unknown>) => {
        const key = invocationKey({ workflowVersionId, nodeId: 'set' });
        checkpoint.invocations = [
          {
            invocationKey: key,
            nodeId: 'set',
            status: 'succeeded',
            attemptNumber: 1,
          },
        ];
        checkpoint.loops = [
          {
            loopId: 'set',
            collection: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000902',
            },
            collectionChecksum: 'checksum',
            collectionSize: 0,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 0,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
        ];
      },
      'workflow_identity_invalid',
      'checkpoint loop does not belong to its scoped For Each control',
    ],
  ] as const)(
    'rejects altered serialized checkpoint %s before admission',
    async (_label, mutate, code, message) => {
      const source = baseCheckpoint();
      const raw = serialized(source) as Record<string, unknown>;
      mutate(raw);
      await expect(advanceWorkflow(advanceInput(raw))).rejects.toMatchObject({
        code,
        message,
      });
      expect(source).toEqual(baseCheckpoint());
    },
  );

  it('rejects an altered serialized V2 selection at the checkpoint decoder', async () => {
    const source = createCheckpointV2({
      engineVersion: 'engine-v2',
      workflowVersionId,
      iterationBudget: 10,
    });
    const raw = serialized(source) as Record<string, unknown>;
    raw.branchSelections = [
      {
        invocationKey: invocationKey({ workflowVersionId, nodeId: 'set' }),
        nodeId: 'set',
        selectedOutputPort: 'out',
      },
    ];
    await expect(advanceWorkflow(advanceInput(raw))).rejects.toMatchObject({
      code: 'checkpoint_invalid',
      message:
        'branch selection requires a succeeded output-bearing invocation',
    });
    expect(source.branchSelections).toEqual([]);
  });

  it('rejects an altered serialized join ledger after the paired-graph check', async () => {
    const executableWithJoin = buildWorkflowExecutableV2({
      graph: pairedParallelGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ parallel: true, merge: true }),
      ),
    });
    const mergeKey = invocationKey({ workflowVersionId, nodeId: 'merge' });
    const source = createCheckpointV2({
      engineVersion: 'engine-v2',
      workflowVersionId,
      iterationBudget: 10,
    });
    const raw = serialized({
      ...source,
      invocations: [
        {
          invocationKey: mergeKey,
          nodeId: 'merge',
          status: 'pending',
          attemptNumber: 0,
        },
      ],
      joins: [
        {
          joinId: 'merge',
          joinInvocationKey: mergeKey,
          policy: { kind: 'all' },
          ledger: [{ branchId: 'branch-99', disposition: 'pending' }],
        },
      ],
    });
    await expect(
      advanceWorkflow({
        ...advanceInput(raw),
        executable: executableWithJoin,
      }),
    ).rejects.toMatchObject({
      code: 'workflow_identity_invalid',
      message: 'checkpoint join disagrees with its paired Parallel',
    });
    expect(source.joins).toEqual([]);
  });

  it('accepts the serialized legacy root join key through the public operation', async () => {
    const executableWithJoin = buildWorkflowExecutableV2({
      graph: pairedParallelGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ parallel: true, merge: true }),
      ),
    });
    const mergeKey = invocationKey({ workflowVersionId, nodeId: 'merge' });
    const source = createCheckpointV2({
      engineVersion: 'engine-v2',
      workflowVersionId,
      iterationBudget: 10,
    });
    const raw = serialized({
      ...source,
      invocations: [
        {
          invocationKey: mergeKey,
          nodeId: 'merge',
          status: 'pending',
          attemptNumber: 0,
        },
      ],
      joins: [
        {
          joinId: 'merge',
          joinInvocationKey: 'merge',
          policy: { kind: 'all' },
          ledger: [
            { branchId: 'branch-01', disposition: 'pending' },
            { branchId: 'branch-02', disposition: 'pending' },
          ],
        },
      ],
    });
    const plan = await advanceWorkflow({
      ...advanceInput(raw),
      executable: executableWithJoin,
    });
    expect(plan.attempts).toEqual([]);
    expect(plan.checkpoint.joins).toEqual([
      expect.objectContaining({ joinId: 'merge', joinInvocationKey: 'merge' }),
    ]);
  });

  it('rejects altered serialized loop bounds after authentic body topology is checked', async () => {
    const executableWithLoop = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true }),
      ),
    });
    const loopKey = invocationKey({ workflowVersionId, nodeId: 'loop' });
    const source = createCheckpointV2({
      engineVersion: 'engine-v2',
      workflowVersionId,
      iterationBudget: 10,
    });
    const raw = serialized({
      ...source,
      invocations: [
        {
          invocationKey: loopKey,
          nodeId: 'loop',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000903',
          },
        },
      ],
      loops: [
        {
          loopId: 'loop',
          controlInvocationKey: loopKey,
          collection: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000903',
          },
          collectionChecksum: 'checksum',
          collectionSize: 0,
          maxConcurrency: 1,
          maxIterations: 1,
          nextOrdinal: 0,
          activeOrdinals: [],
          terminalOrdinals: [],
          bodyRootNodeIds: ['body-first'],
          bodySinkNodeId: 'body-sink',
        },
      ],
    });
    await expect(
      advanceWorkflow({
        ...advanceInput(raw),
        executable: executableWithLoop,
      }),
    ).rejects.toMatchObject({
      code: 'workflow_identity_invalid',
      message:
        'checkpoint loop topology or bounds disagree with the executable',
    });
    expect(source.loops).toEqual([]);
  });

  it('rejects altered serialized observations with the exact public diagnostic', async () => {
    const observations = serialized([
      { kind: 'deadline_expired', occurredAt: 1 },
    ]);
    await expect(
      advanceWorkflow(
        advanceInput(serialized(baseCheckpoint()), { observations }),
      ),
    ).rejects.toMatchObject({
      code: 'observation_invalid',
      message: 'deadline timestamp is invalid',
    });
  });

  it('serializes an authentic transition checkpoint before rejecting tampered state', async () => {
    const initial = await advanceWorkflow(
      advanceInput(serialized(baseCheckpoint())),
    );
    const durable = serialized(initial.checkpoint) as Record<string, unknown>;
    durable.revision = 1.5;
    await expect(advanceWorkflow(advanceInput(durable))).rejects.toMatchObject({
      code: 'checkpoint_invalid',
      message: 'revision is invalid',
    });
    expect(initial.checkpoint.revision).toBe(1);
    expect(parseCheckpoint(serialized(initial.checkpoint))).toEqual(
      initial.checkpoint,
    );
  });
});
