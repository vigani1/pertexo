import { describe, expect, it, vi } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createHash,
  executeNodeAttempt,
  forEachGraph,
  graph,
  invocationKey,
  nodeRelease,
  resolveSingleNodePreviewInput,
} from './executable-workflow.fixtures.js';

function standardExecutable() {
  return buildWorkflowExecutableV2({
    graph: graph(),
    release: composeExecutableCompatibilityRelease(nodeRelease()),
  });
}

function successfulRegistry() {
  return {
    execute: vi.fn((request: { readonly input: unknown }) =>
      Promise.resolve({
        kind: 'succeeded' as const,
        output: request.input as never,
      }),
    ),
  };
}

function setAttempt(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    nodeRunId: 'node-run-1',
    attemptId: 'attempt-1',
    executable: standardExecutable(),
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    invocationKey: invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: 'set',
    }),
    nodeId: 'set',
    runInput: {},
    completedNodeOutputs: { manual: {} },
    registry: successfulRegistry(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('node operation risk branches', () => {
  it('advances the complete shared persisted-fact window', async () => {
    const observations = Array.from({ length: 10_000 }, (_, index) => ({
      kind: 'cancel_requested' as const,
      sequence: index + 2,
      occurredAt: '2026-08-20T10:00:00.000Z',
    }));
    await expect(
      advanceWorkflow({
        runId: 'run-observation-window',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ consumedThroughEventSequence: 10_001 });
  });

  it('rejects one persisted fact over the shared window limit', async () => {
    const observations = Array.from({ length: 10_001 }, (_, index) => ({
      kind: 'cancel_requested' as const,
      sequence: index + 2,
      occurredAt: '2026-08-20T10:00:00.000Z',
    }));
    await expect(
      advanceWorkflow({
        runId: 'run-observation-window',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it.each([
    ['non-array window', { invalid: true }, 'observations must be an array'],
    [
      'numeric deadline timestamp',
      [{ kind: 'deadline_expired', occurredAt: 1 }],
      'deadline timestamp is invalid',
    ],
    [
      'overlong deadline timestamp',
      [{ kind: 'deadline_expired', occurredAt: 'x'.repeat(36) }],
      'deadline timestamp is invalid',
    ],
    [
      'malformed attempt failure',
      [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: 'not-a-uuid',
          attemptNumber: 0,
          failureKind: 'unknown',
          errorKind: 'unknown',
          possiblyDispatched: 'yes',
          safeErrorCode: '',
        },
      ],
      'attempt failure is invalid',
    ],
    [
      'invalid due invocation',
      [
        {
          kind: 'due_at',
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: '',
        },
      ],
      'due observation is invalid',
    ],
    [
      'invalid cursor event name',
      [
        {
          kind: 'cursor_only',
          eventName: 'node.unknown',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
        },
      ],
      'cursor event name is invalid',
    ],
    [
      'invalid cursor attempt',
      [
        {
          kind: 'cursor_only',
          eventName: 'node.progress',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: 'invalid',
          attemptNumber: 0,
        },
      ],
      'cursor event is invalid',
    ],
    [
      'invalid wait correlation',
      [
        {
          kind: 'wait',
          eventName: 'node.waiting',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          resumeAt: '2026-08-20T10:01:00.000Z',
          waitKind: 'node_wait',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000003',
          },
        },
      ],
      'wait observation is invalid',
    ],
    [
      'invalid outcome status',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'unknown',
        },
      ],
      'outcome observation is invalid',
    ],
    [
      'invalid outcome reason code',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'failed',
          reasonCode: '',
        },
      ],
      'reasonCode is invalid',
    ],
    [
      'mismatched inline outcome',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000003',
          },
        },
      ],
      'inline output must reference the completing attempt',
    ],
    [
      'invalid artifact outcome',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'artifact', artifactId: 'invalid' },
        },
      ],
      'artifact output is invalid',
    ],
    [
      'unsupported outcome output',
      [
        {
          kind: 'outcome',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
          invocationKey: 'manual',
          attemptId: '00000000-0000-4000-8000-000000000002',
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'unknown' },
        },
      ],
      'output reference kind is invalid',
    ],
    [
      'unsupported observation kind',
      [
        {
          kind: 'unknown',
          sequence: 2,
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      'observation kind is unsupported by the baseline engine',
    ],
  ] as const)(
    'rejects the public durable-observation boundary for %s',
    async (_label, observations, message) => {
      await expect(
        advanceWorkflow({
          runId: 'run-observation-boundary',
          executable: standardExecutable(),
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          checkpoint: createCheckpoint({
            engineVersion: 'engine-v1',
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
            iterationBudget: 100,
          }),
          observations,
          occurredAt: '2026-08-20T10:00:00.000Z',
          maximumAdmissions: 0,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'observation_invalid', message });
    },
  );

  it('rejects one JSON-compatible fact above the per-fact canonical byte bound', async () => {
    await expect(
      advanceWorkflow({
        runId: 'run-observation-fact-size',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations: [
          {
            kind: 'cancel_requested',
            sequence: 2,
            occurredAt: '2026-08-20T10:00:00.000Z',
            padding: 'x'.repeat(4_096),
          } as never,
        ],
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'observation_invalid',
      message: 'observation fact is too large',
    });
  });

  it('admits a valid wait output before enforcing downstream correlation', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000002';
    await expect(
      advanceWorkflow({
        runId: 'run-valid-wait-output',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations: [
          {
            kind: 'wait',
            eventName: 'node.waiting',
            sequence: 2,
            occurredAt: '2026-08-20T10:00:00.000Z',
            invocationKey: 'missing-invocation',
            attemptId,
            attemptNumber: 1,
            resumeAt: '2026-08-20T10:01:00.000Z',
            waitKind: 'node_wait',
            output: { kind: 'inline', attemptId },
          },
        ],
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it.each([
    {
      name: 'unknown invocation node',
      change: {
        invocations: [
          {
            invocationKey: invocationKey({
              workflowVersionId: '00000000-0000-4000-8000-000000000001',
              nodeId: 'unknown',
            }),
            nodeId: 'unknown',
            status: 'pending',
            attemptNumber: 0,
          },
        ],
      },
    },
    {
      name: 'noncanonical invocation key',
      change: {
        invocations: [
          {
            invocationKey: 'wrong',
            nodeId: 'set',
            status: 'pending',
            attemptNumber: 0,
          },
        ],
      },
    },
    {
      name: 'unknown admitted invocation',
      change: { admittedInvocationKeys: ['missing'] },
    },
    {
      name: 'join without a Merge node',
      change: {
        invocations: [
          {
            invocationKey: invocationKey({
              workflowVersionId: '00000000-0000-4000-8000-000000000001',
              nodeId: 'set',
            }),
            nodeId: 'set',
            status: 'pending',
            attemptNumber: 0,
          },
        ],
        joins: [
          {
            joinId: 'set',
            policy: { kind: 'all' },
            ledger: [{ branchId: 'branch', disposition: 'pending' }],
          },
        ],
      },
    },
    {
      name: 'loop without a For Each node',
      change: {
        invocations: [
          {
            invocationKey: invocationKey({
              workflowVersionId: '00000000-0000-4000-8000-000000000001',
              nodeId: 'set',
            }),
            nodeId: 'set',
            status: 'succeeded',
            attemptNumber: 1,
          },
        ],
        loops: [
          {
            loopId: 'set',
            collection: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000001',
            },
            collectionChecksum: 'sum',
            collectionSize: 0,
            maxConcurrency: 1,
            maxIterations: 1,
            nextOrdinal: 0,
            activeOrdinals: [],
            terminalOrdinals: [],
          },
        ],
      },
    },
  ])(
    'rejects checkpoint/executable identity drift: $name',
    async ({ change }) => {
      const checkpoint = {
        ...createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        ...change,
      };
      await expect(
        advanceWorkflow({
          runId: 'run-identity',
          executable: standardExecutable(),
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          checkpoint,
          observations: [],
          occurredAt: '2026-08-20T10:00:00.000Z',
          maximumAdmissions: 0,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    },
  );

  it('rejects overlong operation identities', async () => {
    await expect(
      executeNodeAttempt(setAttempt({ runId: 'x'.repeat(257) })),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });

  it('rejects an attempt aborted before validation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeNodeAttempt(setAttempt({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });
  });

  it('rejects a disabled executable node', async () => {
    const disabledGraph = structuredClone(graph());
    Object.assign(disabledGraph.nodes[1], { disabled: true });
    await expect(
      executeNodeAttempt(
        setAttempt({
          executable: buildWorkflowExecutableV2({
            graph: disabledGraph,
            release: composeExecutableCompatibilityRelease(nodeRelease()),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });

  it.each([
    { invocationKey: 1, nodeId: 'manual', value: {} },
    { invocationKey: 'wrong', nodeId: 1, value: {} },
    { invocationKey: 'wrong', nodeId: 'terminate', value: {} },
    { invocationKey: 'wrong', nodeId: 'manual', value: {} },
  ])(
    'rejects an inexact completed-output descriptor %#',
    async (descriptor) => {
      await expect(
        executeNodeAttempt(setAttempt({ completedNodeOutputs: [descriptor] })),
      ).rejects.toMatchObject({ code: 'attempt_invalid' });
    },
  );

  it('accepts the exact unscoped completed-output descriptor', async () => {
    await expect(
      executeNodeAttempt(
        setAttempt({
          completedNodeOutputs: [
            {
              invocationKey: invocationKey({
                workflowVersionId: '00000000-0000-4000-8000-000000000001',
                nodeId: 'manual',
              }),
              nodeId: 'manual',
              value: { complete: true },
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ kind: 'succeeded' });
  });

  it('passes an optional execution runtime to the registry', async () => {
    const registry = successfulRegistry();
    const runtime = { secrets: { read: vi.fn() } };
    await executeNodeAttempt(setAttempt({ registry, runtime }));
    expect(registry.execute).toHaveBeenCalledWith(
      expect.objectContaining({ runtime }),
    );
  });

  it('requires a structured collection proof', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true }),
      ),
    });
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }] as const;
    await expect(
      executeNodeAttempt({
        ...setAttempt({ executable }),
        nodeId: 'body-first',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'body-first',
          iterationPath,
        }),
        iterationPath,
        completedNodeOutputs: [],
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });

  it.each([
    { collection: {}, collectionSize: 0, ordinal: 0 },
    { collection: ['item'], collectionSize: 2, ordinal: 0 },
    { collection: ['item'], collectionSize: 1, ordinal: -1 },
    { collection: ['item'], collectionSize: 1, ordinal: 1 },
  ])('rejects an invalid structured collection proof %#', async (proof) => {
    const executable = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true }),
      ),
    });
    const iterationPath = [
      { loopNodeId: 'loop', ordinal: proof.ordinal },
    ] as const;
    await expect(
      executeNodeAttempt({
        ...setAttempt({ executable }),
        nodeId: 'body-first',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'body-first',
          iterationPath,
        }),
        iterationPath,
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: proof.ordinal,
          collection: proof.collection,
          collectionSize: proof.collectionSize,
          declaredCollectionChecksum: createHash('sha256')
            .update(JSON.stringify(proof.collection))
            .digest('hex'),
        },
        completedNodeOutputs: [],
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });

  it('rejects malformed isolated preview boundaries', async () => {
    await expect(
      resolveSingleNodePreviewInput({
        node: null,
        runInput: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview',
          inputMappings: {},
          unexpected: true,
        },
        runInput: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });
});
