import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
} from '@pertexo/database/testing';
import {
  createHttpRequestExecutorRegistration,
  HttpRequestExecutorError,
} from '@pertexo/integrations/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  WorkflowEngineError,
  type NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
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
  registryPreparedAttempt,
} from './support/node-attempt-handler.fixture.js';

function heartbeatCancellationHandler(
  runStore: NodeAttemptRunStore,
  executorControlsDispatch = false,
) {
  return createNodeAttemptHandler({
    engine: {
      prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
    },
    heartbeatIntervalMillis: 10,
    leaseDurationSeconds: 1,
    reader: {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    },
    registry: {
      ...(executorControlsDispatch
        ? { dispatchMode: () => 'executor_controlled' as const }
        : {}),
      execute: vi.fn(
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
      ),
    },
    runStore,
    workerId: 'worker-1',
  });
}

describe('NodeAttemptHandler', () => {
  it('stops heartbeat ownership when an attempt capability constructor fails', async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockResolvedValue({
          abortRequested: false,
          leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
        });
      const constructorError = new Error('connection capability failed');
      const runStore = executionStore({ heartbeat });
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
        },
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 1,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue({
            kind: 'v2_projection',
            workflowVersion: projection(),
          }),
        },
        registry: { execute: vi.fn() },
        runStore,
        runtimeCapabilities: {
          connections: () => {
            throw constructorError;
          },
        },
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(constructorError);
      await vi.advanceTimersByTimeAsync(50);
      expect(heartbeat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'awaits a cancellation-ignoring heartbeat that settles late by %s',
    async (settlement) => {
      vi.useFakeTimers();
      try {
        const heartbeatResult = Promise.withResolvers<{
          abortRequested: false;
          leaseExpiresAt: Date;
        }>();
        const heartbeat = vi
          .fn<NodeAttemptRunStore['heartbeat']>()
          .mockReturnValue(heartbeatResult.promise);
        const contextAbort = new AbortController();
        const handled = heartbeatCancellationHandler(
          executionStore({ heartbeat }),
        ).handle(delivery(), { signal: contextAbort.signal });
        const settled = vi.fn();
        void handled.then(settled, settled);

        await vi.advanceTimersByTimeAsync(10);
        expect(heartbeat).toHaveBeenCalledOnce();
        contextAbort.abort();
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        if (settlement === 'resolve')
          heartbeatResult.resolve({
            abortRequested: false,
            leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
          });
        else heartbeatResult.reject(new Error('late heartbeat failure'));
        await expect(handled).rejects.toMatchObject({
          code: 'attempt_aborted',
        });
        expect(settled).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(50);
        expect(heartbeat).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('normalizes a heartbeat rejection whose prototype inspection is hostile', async () => {
    vi.useFakeTimers();
    try {
      const hostile = new Proxy(Object.create(null) as object, {
        getPrototypeOf: () => {
          throw new Error('hostile prototype');
        },
      });
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockRejectedValue(hostile);
      const handled = heartbeatCancellationHandler(
        executionStore({ heartbeat }),
      ).handle(delivery(), { signal: new AbortController().signal });
      const outcome = handled.then(
        () => undefined,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(10);
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: 'Node attempt heartbeat failed',
      });
      expect((failure as Error).cause).toBe(hostile);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['succeeds', 'rejects'] as const)(
    'gives a heartbeat authority failure precedence when execution ignores abort and %s',
    async (executionSettlement) => {
      vi.useFakeTimers();
      try {
        const heartbeatError = new Error('heartbeat authority unavailable');
        const execution = Promise.withResolvers<{
          runId: string;
          nodeRunId: string;
          attemptId: string;
          invocationKey: string;
          nodeId: string;
          kind: 'succeeded';
          output: null;
        }>();
        const complete = vi.fn<NodeAttemptRunStore['complete']>();
        const runStore = executionStore({
          complete,
          heartbeat: vi.fn().mockRejectedValue(heartbeatError),
        });
        const handler = createNodeAttemptHandler({
          engine: {
            prepare: vi.fn().mockReturnValue({
              upstreamNodeOutputs: [],
              execute: vi.fn().mockReturnValue(execution.promise),
            }),
          },
          heartbeatIntervalMillis: 10,
          leaseDurationSeconds: 1,
          reader: {
            close: vi.fn(),
            readForExecution: vi.fn().mockResolvedValue({
              kind: 'v2_projection',
              workflowVersion: projection(),
            }),
          },
          registry: { execute: vi.fn() },
          runStore,
          workerId: 'worker-1',
        });
        const handled = handler.handle(delivery(), {
          signal: new AbortController().signal,
        });
        const outcome = handled.then(
          () => undefined,
          (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(10);
        if (executionSettlement === 'succeeds')
          execution.resolve({
            runId: lease().runId,
            nodeRunId: lease().nodeRunId,
            attemptId: lease().attemptId,
            invocationKey: lease().invocationKey,
            nodeId: lease().nodeId,
            kind: 'succeeded',
            output: null,
          });
        else execution.reject(new Error('executor also failed'));
        await expect(outcome).resolves.toBe(heartbeatError);
        expect(complete).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not reinterpret a completion-store rejection as an executor outcome', async () => {
    const persistenceError = new NodeExecutorFailure({
      kind: 'retry',
      errorKind: 'provider',
      possiblyDispatched: false,
    });
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockRejectedValue(persistenceError);
    const runStore = executionStore({ complete });

    await expect(
      executionHandler(runStore).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(persistenceError);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([
    ['matching evidence', false],
    ['different evidence', true],
  ] as const)(
    'grants one dispatch permission while durable %s is pending',
    async (_label, useDifferentEvidence) => {
      const marker = Promise.withResolvers<{ dispatchedAt: Date }>();
      const markDispatched = vi
        .fn<NodeAttemptRunStore['markDispatched']>()
        .mockReturnValue(marker.promise);
      const providerIo = vi.fn();
      const firstEvidence = {
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
        providerDispatchBinding: 'email:v1:sha256:' + 'a'.repeat(64),
      } as const;
      const secondEvidence = useDifferentEvidence
        ? {
            connectionFence: {
              ...firstEvidence.connectionFence,
              secretVersionId: '33333333-3333-4333-8333-333333333333',
            },
            providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
          }
        : firstEvidence;
      const registry: NodeExecutionRegistry = {
        dispatchMode: () => 'executor_controlled',
        execute: vi.fn(
          async (request: Parameters<NodeExecutionRegistry['execute']>[0]) => {
            const first = request.runtime?.beforeDispatch(firstEvidence);
            await Promise.resolve();
            await expect(
              request.runtime?.beforeDispatch(secondEvidence),
            ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
            expect(markDispatched).toHaveBeenCalledOnce();
            marker.resolve({ dispatchedAt: new Date() });
            await first;
            providerIo();
            return { kind: 'succeeded', output: null } as const;
          },
        ),
      };
      const runStore = executionStore({ markDispatched });
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
        },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue({
            kind: 'v2_projection',
            workflowVersion: projection(),
          }),
        },
        registry,
        runStore,
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(providerIo).toHaveBeenCalledOnce();
    },
  );

  it('keeps a queue abort from reopening a pending dispatch marker', async () => {
    const marker = Promise.withResolvers<{ dispatchedAt: Date }>();
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockReturnValue(marker.promise);
    const complete = vi.fn<NodeAttemptRunStore['complete']>();
    const contextAbort = new AbortController();
    const registry: NodeExecutionRegistry = {
      dispatchMode: () => 'executor_controlled',
      execute: vi.fn(
        async (request: Parameters<NodeExecutionRegistry['execute']>[0]) => {
          const first = request.runtime?.beforeDispatch();
          await Promise.resolve();
          await expect(request.runtime?.beforeDispatch()).rejects.toMatchObject(
            {
              code: 'duplicate_dispatch',
            },
          );
          contextAbort.abort();
          marker.reject(contextAbort.signal.reason);
          await first;
          return { kind: 'succeeded', output: null } as const;
        },
      ),
    };
    const runStore = executionStore({ complete, markDispatched });
    const handler = createNodeAttemptHandler({
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
      registry,
      runStore,
      workerId: 'worker-1',
    });

    const failure = await handler
      .handle(delivery(), { signal: contextAbort.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBe(contextAbort.signal.reason);
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(markDispatched.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses the combined execution signal but the exact queue signal for completion', async () => {
    const contextAbort = new AbortController();
    let executionSignal: AbortSignal | undefined;
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const runStore = executionStore({ complete });
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute: vi.fn(
            (input: Parameters<PreparedNodeAttempt['execute']>[0]) => {
              executionSignal = input.signal;
              return Promise.resolve({
                runId: lease().runId,
                nodeRunId: lease().nodeRunId,
                attemptId: lease().attemptId,
                invocationKey: lease().invocationKey,
                nodeId: lease().nodeId,
                kind: 'succeeded',
                output: null,
              } as const);
            },
          ),
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      registry: { execute: vi.fn() },
      runStore,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: contextAbort.signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(executionSignal).toBeInstanceOf(AbortSignal);
    expect(executionSignal).not.toBe(contextAbort.signal);
    expect(complete.mock.calls[0]?.[0].signal).toBe(contextAbort.signal);
  });

  it.each([
    [new NodeAttemptConnectionFenceError(), 'provider_connection_fence_failed'],
    [
      new NodeAttemptDispatchBindingMismatchError(),
      'provider_dispatch_binding_mismatch',
    ],
    [new Error('queue marker aborted'), undefined],
  ] as const)(
    'does not reopen dispatch permission after a pending marker rejects',
    async (markerError, mappedCode) => {
      const marker = Promise.withResolvers<{ dispatchedAt: Date }>();
      const markDispatched = vi
        .fn<NodeAttemptRunStore['markDispatched']>()
        .mockReturnValue(marker.promise);
      const complete = vi.fn<NodeAttemptRunStore['complete']>();
      const registry: NodeExecutionRegistry = {
        dispatchMode: () => 'executor_controlled',
        execute: vi.fn(
          async (request: Parameters<NodeExecutionRegistry['execute']>[0]) => {
            const first = request.runtime?.beforeDispatch();
            await Promise.resolve();
            await expect(
              request.runtime?.beforeDispatch({
                providerDispatchBinding: 'email:v1:sha256:' + 'c'.repeat(64),
              }),
            ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
            marker.reject(markerError);
            await first;
            return { kind: 'succeeded', output: null } as const;
          },
        ),
      };
      const runStore = executionStore({ complete, markDispatched });
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
        },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue({
            kind: 'v2_projection',
            workflowVersion: projection(),
          }),
        },
        registry,
        runStore,
        workerId: 'worker-1',
      });

      const handled = expect(
        handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects;
      if (mappedCode === undefined) await handled.toBe(markerError);
      else await handled.toMatchObject({ code: mappedCode });
      expect(markDispatched).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
    },
  );

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

  it('preserves prior dispatch uncertainty when cancellation arrives before redispatch', async () => {
    const attemptLease = {
      ...lease(),
      sideEffectClass: 'idempotent_with_key' as const,
      providerIdempotencyKey: 'stable-provider-key',
      providerDispatchUnresolved: true as const,
    };
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const markDispatched = vi.fn<NodeAttemptRunStore['markDispatched']>();
    const runStore = executionStore({
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      complete,
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: true,
        abortReason: 'canceled',
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched,
    });

    await expect(
      executionHandler(runStore).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'outcome_unknown',
          safeErrorCode: 'execution.outcome_unknown',
        },
      }),
    );
    expect(markDispatched).not.toHaveBeenCalled();
  });

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

  it.each(['canceled', 'timed_out'] as const)(
    'preserves prior dispatch uncertainty when heartbeat reports %s before redispatch',
    async (abortReason) => {
      const attemptLease = {
        ...lease(),
        sideEffectClass: 'idempotent_with_key' as const,
        providerIdempotencyKey: 'stable-provider-key',
        providerDispatchUnresolved: true as const,
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
      const markDispatched = vi.fn<NodeAttemptRunStore['markDispatched']>();
      const store = executionStore({
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
        complete,
        heartbeat,
        markDispatched,
      });
      const handler = heartbeatCancellationHandler(store, true);

      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(markDispatched).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: attemptLease,
          outcome: {
            status: 'outcome_unknown',
            safeErrorCode: 'execution.outcome_unknown',
          },
        }),
      );
    },
  );

  it('normalizes a non-Error heartbeat rejection', async () => {
    const heartbeat = vi.fn<NodeAttemptRunStore['heartbeat']>();
    // Deliberately model a hostile persistence adapter rejection.
    heartbeat.mockRejectedValue(undefined);
    const handler = heartbeatCancellationHandler(executionStore({ heartbeat }));

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: 'Error',
      message: 'Node attempt heartbeat failed',
    });
    expect(heartbeat).toHaveBeenCalledOnce();
  });

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

  it('persists a real HTTP credential-resolution outage as a durable retry', async () => {
    const attemptLease = { ...lease(), sideEffectClass: 'unsafe' as const };
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockResolvedValue({ dispatchedAt: new Date() });
    const store = executionStore({
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      complete,
      markDispatched,
    });
    const providerIo = vi.fn();
    const registration = createHttpRequestExecutorRegistration({
      httpClient: { executeStreaming: providerIo },
    });
    const resolveFailure = new Error('temporary connection-store outage');
    const resolve = vi.fn().mockRejectedValue(resolveFailure);
    const execute: PreparedNodeAttempt['execute'] = async ({
      registry,
      signal,
    }) => {
      const result = await registry.execute({
        definition: { key: 'http.request', version: 1 },
        executor: { key: 'http.request', version: 1 },
        config: {
          method: 'POST',
          url: 'https://provider.example.test/v1/items',
          headers: {},
          timeoutMillis: 10_000,
          maxRedirects: 0,
          maxResponseBytes: 1_048_576,
          inlineResponseBytes: 65_536,
        },
        input: {},
        connectionRefs: {
          http_headers: '88888888-8888-4888-8888-888888888888',
        },
        signal,
      });
      return {
        runId: attemptLease.runId,
        nodeRunId: attemptLease.nodeRunId,
        attemptId: attemptLease.attemptId,
        invocationKey: attemptLease.invocationKey,
        nodeId: attemptLease.nodeId,
        kind: result.kind,
        output: result.output,
      };
    };
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute,
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
      registry: {
        dispatchMode: () => 'executor_controlled',
        execute: async (request) => {
          await registration.execute({
            ...request,
            connectionRefs: request.connectionRefs ?? {},
          });
          return { kind: 'succeeded', output: null };
        },
      },
      runStore: store,
      runtimeCapabilities: {
        connections: () => ({
          assertCurrent: vi.fn().mockResolvedValue(undefined),
          resolve,
        }),
      },
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(resolve).toHaveBeenCalledOnce();
    expect(providerIo).not.toHaveBeenCalled();
    expect(markDispatched).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: attemptLease,
        outcome: {
          status: 'executor_failure',
          failureKind: 'retry',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'execution.provider',
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
      const handler = heartbeatCancellationHandler(store);

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
