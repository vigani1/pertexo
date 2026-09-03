import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
} from '@pertexo/database/testing';
import { HttpRequestExecutorError } from '@pertexo/integrations/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../src/testing.js';
import {
  TRACEPARENT,
  WORKFLOW_ID,
  delivery,
  executionHandler,
  executionStore,
  lease,
  projection,
} from './support/node-attempt-handler.fixture.js';

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
