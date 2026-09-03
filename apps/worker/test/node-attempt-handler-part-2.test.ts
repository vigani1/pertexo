import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
  PublishedWorkflowReader,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/testing';
import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
} from '@pertexo/database/testing';
import { JOB_NAME, type QueueDelivery } from '@pertexo/queue';
import { HttpRequestExecutorError } from '@pertexo/integrations/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../src/testing.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';
const VERSION_ID = '66666666-6666-4666-8666-666666666666';
const WORKFLOW_ID = '77777777-7777-4777-8777-777777777777';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function delivery(
  traceparent?: string,
): Extract<QueueDelivery, { name: 'execute-node-attempt' }> {
  return {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      attemptId: ATTEMPT_ID,
      outboxEventId: OUTBOX_EVENT_ID,
      ...(traceparent === undefined ? {} : { traceparent }),
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
    admissionKind: 'execute',
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

function registryPreparedAttempt(): PreparedNodeAttempt {
  return {
    upstreamNodeOutputs: [],
    execute: async ({ registry, signal }) => {
      const result = await registry.execute({
        config: {},
        definition: { key: 'core.manual', version: 1 },
        executor: { key: 'core.manual', version: 1 },
        input: null,
        signal,
      });
      return {
        runId: RUN_ID,
        nodeRunId: NODE_RUN_ID,
        attemptId: ATTEMPT_ID,
        invocationKey: lease().invocationKey,
        nodeId: 'manual',
        kind: result.kind,
        output: result.output,
      };
    },
  };
}

function executionStore(
  overrides: Partial<NodeAttemptRunStore> = {},
): NodeAttemptRunStore {
  return {
    claimDelivery: vi
      .fn()
      .mockResolvedValue({ kind: 'claimed', lease: lease() }),
    close: vi.fn(),
    complete: vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID }),
    heartbeat: vi.fn(),
    loadInputs: vi.fn().mockResolvedValue({
      abortRequested: false,
      completedNodeOutputs: {},
      runInput: null,
    }),
    markDispatched: vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockResolvedValue({ dispatchedAt: new Date() }),
    ...overrides,
  };
}

function executionHandler(runStore: NodeAttemptRunStore) {
  return createNodeAttemptHandler({
    engine: { prepare: vi.fn().mockReturnValue(registryPreparedAttempt()) },
    heartbeatIntervalMillis: 1_000,
    leaseDurationSeconds: 30,
    reader: {
      close: vi.fn(),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    },
    registry: {
      execute: vi.fn().mockResolvedValue({ kind: 'succeeded', output: null }),
    },
    runStore,
    workerId: 'worker-1',
  });
}

describe('NodeAttemptHandler', () => {
  it.each([
    [new NodeAttemptConnectionFenceError(), 'provider_connection_fence_failed'],
    [
      new NodeAttemptDispatchBindingMismatchError(),
      'provider_dispatch_binding_mismatch',
    ],
  ] as const)(
    'maps durable dispatch evidence failures to %s',
    async (error, code) => {
      const runStore = executionStore({
        markDispatched: vi.fn().mockRejectedValue(error),
      });

      await expect(
        executionHandler(runStore).handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([undefined, TRACEPARENT])(
    'converts invalid persisted output to a safe failure with optional trace %s',
    async (traceparent) => {
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockRejectedValueOnce(new NodeAttemptOutputInvalidError())
        .mockResolvedValueOnce({
          kind: 'committed',
          outboxEventId: WORKFLOW_ID,
        });
      const runStore = executionStore({ complete });

      await expect(
        executionHandler(runStore).handle(delivery(traceparent), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: {
            status: 'failed',
            safeErrorCode: 'execution.output_invalid',
          },
          ...(traceparent === undefined ? {} : { traceparent }),
        }),
      );
    },
  );

  it.each([
    ['canceled', 'execution.canceled'],
    ['timed_out', 'execution.deadline_exceeded'],
  ] as const)(
    'records durable %s before dispatching an executor',
    async (abortReason, safeErrorCode) => {
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
          abortReason,
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
          prepare: vi
            .fn()
            .mockReturnValue({ upstreamNodeOutputs: [], execute }),
        },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader,
        registry: { execute: vi.fn() },
        runStore: store,
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(TRACEPARENT), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(execute).not.toHaveBeenCalled();
      expect(store.markDispatched).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[0]).toMatchObject({
        lease: attemptLease,
        outcome: { status: abortReason, safeErrorCode },
      });
      expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    },
  );

  it.each([undefined, TRACEPARENT])(
    'fails a typed invalid attempt without exposing details for trace %s',
    async (traceparent) => {
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
            upstreamNodeOutputs: [],
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
        handler.handle(delivery(traceparent), {
          signal: new AbortController().signal,
        }),
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
    },
  );

  it('persists a typed unsafe provider ambiguity as outcome_unknown', async () => {
    const attemptLease = { ...lease(), sideEffectClass: 'unsafe' as const };
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
          upstreamNodeOutputs: [],
          execute: vi.fn().mockRejectedValue(
            new NodeExecutorFailure({
              kind: 'outcome_unknown',
              errorKind: 'provider',
              possiblyDispatched: true,
            }),
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
      handler.handle(delivery(TRACEPARENT), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'executor_failure',
          failureKind: 'outcome_unknown',
          errorKind: 'provider',
          possiblyDispatched: true,
          safeErrorCode: 'execution.provider',
        },
      }),
    );
  });

  it('persists a pre-dispatch HTTP retry for the coordinator without scheduling', async () => {
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
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute: vi.fn().mockRejectedValue(
            new HttpRequestExecutorError(
              {
                kind: 'retry',
                errorKind: 'rate_limit',
                reuseProviderKey: false,
              },
              false,
            ),
          ),
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: attemptLease,
        outcome: {
          status: 'executor_failure',
          failureKind: 'retry',
          errorKind: 'rate_limit',
          possiblyDispatched: false,
          safeErrorCode: 'execution.rate_limit',
        },
      }),
    );
  });

  it.each([
    ['canceled', 'unsafe', 'outcome_unknown', 'execution.outcome_unknown'],
    ['timed_out', 'unsafe', 'outcome_unknown', 'execution.outcome_unknown'],
    ['canceled', 'safe', 'canceled', 'execution.canceled'],
    [
      'canceled',
      'idempotent_with_key',
      'outcome_unknown',
      'execution.outcome_unknown',
    ],
    [
      'timed_out',
      'idempotent_with_key',
      'outcome_unknown',
      'execution.outcome_unknown',
    ],
  ] as const)(
    'classifies post-dispatch durable %s for %s work as %s',
    async (abortReason, sideEffectClass, status, safeErrorCode) => {
      const attemptLease = {
        ...lease(),
        sideEffectClass,
        ...(sideEffectClass === 'idempotent_with_key'
          ? { providerIdempotencyKey: 'stable-provider-key' }
          : {}),
      };
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockResolvedValue({
          leaseExpiresAt: new Date('2026-08-21T00:02:00.000Z'),
          abortRequested: true,
          abortReason,
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
      const registryExecute = vi.fn(
        (input: { signal: AbortSignal }): Promise<never> =>
          new Promise((_resolve, reject) => {
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
      const execute = vi.fn(
        async ({
          registry,
          signal,
        }: Parameters<PreparedNodeAttempt['execute']>[0]) =>
          registry.execute({
            definition: { key: 'core.manual', version: 1 },
            executor: { key: 'core.manual', version: 1 },
            config: {},
            input: null,
            signal,
          }),
      );
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi
            .fn()
            .mockReturnValue({ upstreamNodeOutputs: [], execute }),
        },
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 1,
        reader,
        registry: { execute: registryExecute },
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
        outcome: { status, safeErrorCode },
      });
      expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    },
  );
});
