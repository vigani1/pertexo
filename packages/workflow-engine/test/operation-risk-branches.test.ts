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
