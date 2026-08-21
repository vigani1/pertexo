import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
  PublishedWorkflowReader,
  PublishedWorkflowV2Projection,
} from '@pertexo/database';
import { JOB_NAME, type QueueDelivery } from '@pertexo/queue';
import {
  type NodeExecutionRegistry,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type PreparedNodeAttempt,
} from '../src/execution/node-attempt-handler.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';
const VERSION_ID = '66666666-6666-4666-8666-666666666666';
const WORKFLOW_ID = '77777777-7777-4777-8777-777777777777';

function delivery(): Extract<QueueDelivery, { name: 'execute-node-attempt' }> {
  return {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      attemptId: ATTEMPT_ID,
      outboxEventId: OUTBOX_EVENT_ID,
    },
    transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
  };
}

function projection(): PublishedWorkflowV2Projection {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    schemaVersion: 1,
    checksum:
      'wf:v2:sha256:1111111111111111111111111111111111111111111111111111111111111111',
    executableSchemaVersion: 2,
    executableJson: { schemaVersion: 2 },
    compatibilityReleaseEpoch: 1,
  };
}

function lease(): NodeAttemptLease {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    nodeRunId: NODE_RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    invocationKey: `${VERSION_ID}|manual|b:|i:`,
    nodeId: 'manual',
    sideEffectClass: 'safe',
    workerId: 'worker-1',
    fenceToken: 1,
    leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    delivery: {
      outboxEventId: OUTBOX_EVENT_ID,
      payloadChecksum: 'a'.repeat(64),
    },
  };
}

describe('NodeAttemptHandler', () => {
  it('treats an exact completed delivery as a no-op before loading workflow state', async () => {
    const claimDelivery = vi.fn().mockResolvedValue({ kind: 'duplicate' });
    const store = {
      claimDelivery,
      close: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      heartbeat: vi.fn(),
      loadInputs: vi.fn(),
      markDispatched: vi.fn(),
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn(),
    } satisfies PublishedWorkflowReader;
    const engine = {
      prepare: vi.fn(),
    } satisfies NodeAttemptExecutionEngine;
    const handler = createNodeAttemptHandler({
      engine,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader,
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(reader.readForExecution).not.toHaveBeenCalled();
    expect(engine.prepare).not.toHaveBeenCalled();
  });

  it('loads exact inputs, marks dispatch at the registry seam, and commits success', async () => {
    const attemptLease = lease();
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockResolvedValue({ dispatchedAt: new Date() });
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const store = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      close: vi.fn().mockResolvedValue(undefined),
      complete,
      heartbeat: vi.fn(),
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: { hello: 'world' },
      }),
      markDispatched,
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    } satisfies PublishedWorkflowReader;
    const execute = vi.fn(
      async ({
        registry,
        signal,
      }: Parameters<PreparedNodeAttempt['execute']>[0]) => {
        const result = await registry.execute({
          definition: { key: 'core.manual', version: 1 },
          executor: { key: 'core.manual', version: 1 },
          config: {},
          input: { hello: 'world' },
          signal,
        });
        return {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          attemptId: ATTEMPT_ID,
          invocationKey: attemptLease.invocationKey,
          nodeId: 'manual',
          kind: result.kind,
          output: result.output,
        } as const;
      },
    );
    const engine = {
      prepare: vi.fn().mockReturnValue({ upstreamNodeIds: [], execute }),
    } satisfies NodeAttemptExecutionEngine;
    const registryExecute = vi
      .fn<NodeExecutionRegistry['execute']>()
      .mockResolvedValue({
        kind: 'succeeded',
        output: { hello: 'world' },
      });
    const resync = vi.fn().mockResolvedValue({ receivers: 1 });
    const handler = createNodeAttemptHandler({
      engine,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      notifications: {
        close: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn(),
        resync,
      },
      reader,
      registry: { execute: registryExecute },
      runStore: store,
      workerId: 'worker-1',
    });
    const signal = new AbortController().signal;

    await expect(handler.handle(delivery(), { signal })).resolves.toEqual({
      kind: 'committed',
    });
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(markDispatched.mock.calls[0]?.[0].lease).toBe(attemptLease);
    expect(markDispatched.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(registryExecute).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      lease: attemptLease,
      outcome: { status: 'succeeded', output: { hello: 'world' } },
    });
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(resync).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
    });
  });

  it('records durable cancellation before dispatching an executor', async () => {
    const attemptLease = lease();
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const store = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      close: vi.fn().mockResolvedValue(undefined),
      complete,
      heartbeat: vi.fn(),
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: true,
        abortReason: 'canceled',
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched: vi.fn(),
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    } satisfies PublishedWorkflowReader;
    const execute = vi.fn();
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({ upstreamNodeIds: [], execute }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader,
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(execute).not.toHaveBeenCalled();
    expect(store.markDispatched).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      lease: attemptLease,
      outcome: {
        status: 'canceled',
        safeErrorCode: 'execution.canceled',
      },
    });
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('fails a typed invalid attempt without exposing internal details', async () => {
    const attemptLease = lease();
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const store = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      close: vi.fn().mockResolvedValue(undefined),
      complete,
      heartbeat: vi.fn(),
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched: vi.fn(),
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    } satisfies PublishedWorkflowReader;
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeIds: [],
          execute: vi
            .fn()
            .mockRejectedValue(
              new WorkflowEngineError('attempt_invalid', 'secret detail'),
            ),
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader,
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      lease: attemptLease,
      outcome: {
        status: 'failed',
        safeErrorCode: 'execution.attempt_invalid',
      },
    });
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('heartbeats a running attempt and converts durable cancellation into a terminal fact', async () => {
    const attemptLease = lease();
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const heartbeat = vi
      .fn<NodeAttemptRunStore['heartbeat']>()
      .mockResolvedValue({
        leaseExpiresAt: new Date('2026-08-21T00:02:00.000Z'),
        abortRequested: true,
        abortReason: 'canceled',
      });
    const store = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      close: vi.fn().mockResolvedValue(undefined),
      complete,
      heartbeat,
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched: vi.fn(),
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    } satisfies PublishedWorkflowReader;
    const execute = vi.fn(
      (input: { signal: AbortSignal }): Promise<never> =>
        new Promise((_, reject) => {
          input.signal.addEventListener(
            'abort',
            () => {
              reject(
                new WorkflowEngineError(
                  'attempt_aborted',
                  'durable cancellation',
                ),
              );
            },
            { once: true },
          );
        }),
    );
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({ upstreamNodeIds: [], execute }),
      },
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 1,
      reader,
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      lease: attemptLease,
      outcome: {
        status: 'canceled',
        safeErrorCode: 'execution.canceled',
      },
    });
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });
});
