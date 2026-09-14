import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  PreviewAttemptStateError,
} from '@pertexo/database/execution';
import { jobIdForOutboxEvent } from '@pertexo/queue';
import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';
import type {
  PreviewAttemptLease,
  PreviewTerminalOutcome,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewAttemptHandler,
  PreviewAttemptHandlerStateError,
  type PreviewAttemptHandlerDependencies,
  type PreviewInvocationOutcome,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
} from '../src/execution/preview-attempt-handler.js';

const workspaceId = randomUUID();
const outboxEventId = randomUUID();
const previewRunId = randomUUID();
const previewAttemptId = randomUUID();

function leaseFixture(): PreviewAttemptLease {
  return {
    attemptFenceToken: 1,
    compatibilityReleaseEpoch: 1,
    compatibilityReleaseFingerprint: 'node-compat:v1:sha256:' + 'a'.repeat(64),
    definitionKey: 'core.set',
    definitionVersion: 1,
    dryRun: 'not_supported',
    executableNode: Object.freeze({
      config: { value: 1 },
      id: 'node-1',
    }),
    executorKey: 'core.set',
    executorVersion: 1,
    executionDeadlineAt: new Date(Date.now() + 4 * 60 * 1_000),
    retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    input: { kind: 'inline', schemaVersion: 1, value: { n: 1 } },
    mayCauseExternalSideEffect: false,
    mayContactProvider: true,
    nodeId: 'node-1',
    operationKey: 'set',
    previewAttemptId,
    previewRunId,
    providerKey: 'core',
    sideEffectClass: 'safe',
    workflowId: randomUUID(),
    workspaceId,
  };
}

function deliveryFixture(): Parameters<
  ReturnType<typeof createPreviewAttemptHandler>['handle']
>[0] {
  return {
    data: {
      outboxEventId,
      previewAttemptId,
      previewRunId,
      schemaVersion: 1,
      traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01',
      workspaceId,
    },
    name: 'execute-preview-attempt' as const,
    transport: {
      attemptsMade: 0,
      jobId: jobIdForOutboxEvent(outboxEventId),
    },
  };
}

function context(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

interface StoreCalls {
  bindings: (string | undefined)[];
  connectionFences: unknown[];
  claims: number;
  completions: PreviewTerminalOutcome[];
  completionSignals: (AbortSignal | undefined)[];
  dispatches: number;
}

function fakeStore(
  overrides: Partial<{
    beat: { runExecutionDeadlineAt: Date };
    claimKind: 'duplicate';
    heartbeatError: Error;
    lease: PreviewAttemptLease;
  }> = {},
): { calls: StoreCalls; store: PreviewAttemptRunStore } {
  const calls: StoreCalls = {
    bindings: [],
    connectionFences: [],
    claims: 0,
    completions: [],
    completionSignals: [],
    dispatches: 0,
  };
  const store: PreviewAttemptRunStore = {
    claim: () => {
      calls.claims += 1;
      if (overrides.claimKind === 'duplicate')
        return Promise.resolve({ kind: 'duplicate' });
      return Promise.resolve({
        kind: 'claimed',
        lease: overrides.lease ?? leaseFixture(),
      });
    },
    complete: ({ outcome, signal }) => {
      calls.completions.push(outcome);
      calls.completionSignals.push(signal);
      return Promise.resolve({ kind: 'committed' });
    },
    heartbeat: () => {
      if (overrides.heartbeatError !== undefined)
        return Promise.reject(overrides.heartbeatError);
      const beat = overrides.beat ?? {
        runExecutionDeadlineAt: new Date(Date.now() + 60 * 60 * 1_000),
      };
      return Promise.resolve({
        attemptLeaseExpiresAt: new Date(Date.now() + 30 * 1_000),
        runExecutionDeadlineAt: beat.runExecutionDeadlineAt,
      });
    },
    markDispatched: ({ connectionFence, providerDispatchBinding }) => {
      calls.bindings.push(providerDispatchBinding);
      calls.connectionFences.push(connectionFence);
      calls.dispatches += 1;
      return Promise.resolve('committed');
    },
  };
  return { calls, store };
}

function succeededInvoker(output: unknown): {
  invoker: PreviewNodeInvoker;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(() =>
    Promise.resolve({
      output,
      status: 'succeeded' as const,
    }),
  );
  return { invoke, invoker: { invoke } };
}

function deps(
  store: PreviewAttemptRunStore,
  invoker: PreviewNodeInvoker,
): PreviewAttemptHandlerDependencies {
  return {
    heartbeatIntervalMillis: 10,
    invoker,
    leaseDurationSeconds: 30,
    runStore: store,
    workerId: 'worker-preview-test',
  };
}

describe('preview attempt handler', () => {
  it('claims the exact transport identity and checksum', async () => {
    const { store } = fakeStore();
    const claim = vi.fn(
      (input: Parameters<PreviewAttemptRunStore['claim']>[0]) =>
        store.claim(input),
    );
    const delivery = deliveryFixture();
    const queueContext = context();
    await createPreviewAttemptHandler({
      ...deps({ ...store, claim }, succeededInvoker({ ok: true }).invoker),
    }).handle(delivery, queueContext);

    expect(claim).toHaveBeenCalledWith({
      delivery: {
        outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
      },
      leaseDurationSeconds: 30,
      previewAttemptId,
      previewRunId,
      signal: queueContext.signal,
      workerId: 'worker-preview-test',
      workspaceId,
    });
  });

  it('wraps raw executor output into the stored envelope and commits truthfully', async () => {
    const { calls, store } = fakeStore();
    const { invoker } = succeededInvoker({ ok: true });
    const recordTerminal = vi.fn();
    const queueContext = context();
    const result = await createPreviewAttemptHandler({
      ...deps(store, invoker),
      telemetry: { recordReconciliation: vi.fn(), recordTerminal },
    }).handle(deliveryFixture(), queueContext);
    expect(result).toEqual({ kind: 'committed' });
    expect(calls.claims).toBe(1);
    expect(calls.completions[0]?.status).toBe('succeeded');
    expect(calls.completionSignals).toEqual([queueContext.signal]);
    const stored = calls.completions[0] as unknown as {
      output: { value: { ok: boolean } };
    };
    expect(stored.output.value).toEqual({ ok: true });
    expect(recordTerminal).toHaveBeenCalledWith({
      mayContactProvider: true,
      mayCauseExternalSideEffect: false,
      operationKey: 'set',
      outcome: 'succeeded',
      possiblyDispatched: false,
      providerKey: 'core',
      sideEffectClass: 'safe',
      source: 'execution',
      usesConnection: false,
    });
  });

  it('cancels a deferred terminal write with the transport signal', async () => {
    const { store } = fakeStore();
    const completionStarted = Promise.withResolvers<AbortSignal>();
    const reason = new Error('queue delivery revoked during completion');
    const complete = vi.fn(
      ({ signal }: Parameters<PreviewAttemptRunStore['complete']>[0]) =>
        new Promise<never>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('completion signal missing'));
            return;
          }
          completionStarted.resolve(signal);
          signal.addEventListener(
            'abort',
            () => {
              reject(reason);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = createPreviewAttemptHandler({
      ...deps({ ...store, complete }, succeededInvoker({ ok: true }).invoker),
    }).handle(deliveryFixture(), { signal: controller.signal });

    const completionSignal = await completionStarted.promise;
    expect(completionSignal).toBe(controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('passes retained preview expiry to the artifact capability', async () => {
    const lease = leaseFixture();
    const { store } = fakeStore({ lease });
    const artifactFactory = vi.fn(() => ({ write: vi.fn() }));
    const invoker: PreviewNodeInvoker = {
      invoke: ({ runtime }) => {
        expect(runtime).toMatchObject({
          attemptId: previewAttemptId,
          attemptNumber: 1,
          invocationKey: 'preview:node-1',
          nodeId: 'node-1',
          nodeRunId: previewRunId,
          runId: previewRunId,
          workspaceId,
        });
        expect(runtime?.artifacts).toBeDefined();
        return Promise.resolve({ output: { ok: true }, status: 'succeeded' });
      },
    };

    await createPreviewAttemptHandler({
      ...deps(store, invoker),
      runtimeCapabilities: { artifacts: artifactFactory },
    }).handle(deliveryFixture(), context());

    expect(artifactFactory).toHaveBeenCalledWith({
      artifactRetentionDeadline: lease.retentionExpiresAt,
      attemptId: previewAttemptId,
      attemptNumber: 1,
      invocationKey: 'preview:node-1',
      nodeId: 'node-1',
      nodeRunId: previewRunId,
      previewAttemptId,
      previewRunId,
      runId: previewRunId,
      workerId: 'worker-preview-test',
      workspaceId,
    });
  });

  it('persists an executor artifact reference inside the bounded preview output', async () => {
    const { calls, store } = fakeStore();
    const artifactId = randomUUID();
    const write = vi.fn(() =>
      Promise.resolve({
        artifactId,
        byteLength: 70_000,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      }),
    );
    const invoker: PreviewNodeInvoker = {
      invoke: async ({ runtime, signal }) => {
        const reference = await runtime?.artifacts?.write({
          body: (async function* (): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield new Uint8Array([1]);
          })(),
          maxBytes: 100_000,
          mediaType: 'application/octet-stream',
          purpose: 'node-output',
          signal,
        });
        return {
          output: { body: { kind: 'artifact', ...reference } },
          status: 'succeeded',
        };
      },
    };

    await createPreviewAttemptHandler({
      ...deps(store, invoker),
      runtimeCapabilities: { artifacts: () => ({ write }) },
    }).handle(deliveryFixture(), context());

    expect(write).toHaveBeenCalledOnce();
    expect(calls.completions[0]).toMatchObject({
      output: {
        kind: 'inline',
        schemaVersion: 1,
        value: { body: { kind: 'artifact', artifactId } },
      },
      status: 'succeeded',
    });
  });

  it('returns duplicates without invoking the executor', async () => {
    const { calls, store } = fakeStore({ claimKind: 'duplicate' });
    const invoke = vi.fn();
    const recordTerminal = vi.fn();
    const result = await createPreviewAttemptHandler({
      ...deps(store, { invoke }),
      telemetry: { recordReconciliation: vi.fn(), recordTerminal },
    }).handle(deliveryFixture(), context());
    expect(result).toEqual({ kind: 'duplicate' });
    expect(invoke).not.toHaveBeenCalled();
    expect(calls.completions).toHaveLength(0);
    expect(recordTerminal).not.toHaveBeenCalled();
  });

  it.each([
    [
      'failed pre-dispatch retryable network truth',
      { safeErrorCode: 'preview.network', status: 'failed' },
    ],
    [
      'post-dispatch ambiguity becomes outcome_unknown',
      {
        safeErrorCode: 'preview.outcome_unknown',
        status: 'outcome_unknown',
      },
    ],
    [
      'cancellation stays cancellation',
      { safeErrorCode: 'execution.canceled', status: 'canceled' },
    ],
  ])('%s', async (_label, expected) => {
    const { calls, store } = fakeStore();
    // The invoker owns ADR 007 classification; these mirror the platform
    // invoker's mapping of executor decision errors.
    const invoker: PreviewNodeInvoker = {
      invoke: () => Promise.resolve(expected as PreviewInvocationOutcome),
    };
    const queueContext = context();
    await createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      queueContext,
    );
    expect(calls.completions[0]).toMatchObject(expected);
    expect(calls.completionSignals).toEqual([queueContext.signal]);
  });

  it.each(['unsafe', 'idempotent_with_key'] as const)(
    'upgrades a dispatched %s cancellation to outcome_unknown',
    async (sideEffectClass) => {
      const lease = {
        ...leaseFixture(),
        sideEffectClass,
        ...(sideEffectClass === 'idempotent_with_key'
          ? { providerIdempotencyKey: 'stable-provider-key' }
          : {}),
      };
      const { calls, store } = fakeStore({ lease });
      const invoker: PreviewNodeInvoker = {
        invoke: async ({ runtime }) => {
          await runtime?.beforeDispatch();
          return {
            safeErrorCode: 'execution.canceled',
            status: 'canceled',
          };
        },
      };

      await createPreviewAttemptHandler(deps(store, invoker)).handle(
        deliveryFixture(),
        context(),
      );

      expect(calls.dispatches).toBe(1);
      expect(calls.completions[0]).toEqual({
        safeErrorCode: 'preview.outcome_unknown',
        status: 'outcome_unknown',
      });
    },
  );

  it('passes an executor-controlled provider binding to durable preview dispatch', async () => {
    const { calls, store } = fakeStore();
    const binding = 'email:v1:sha256:' + 'b'.repeat(64);
    const invoker: PreviewNodeInvoker = {
      invoke: async ({ runtime }) => {
        await runtime?.beforeDispatch({
          connectionFence: {
            connectionId: '11111111-1111-4111-8111-111111111111',
            expectedProviderKey: 'email',
            expectedAuthType: 'resend_api_key',
            secretVersionId: '22222222-2222-4222-8222-222222222222',
          },
          providerDispatchBinding: binding,
        });
        return { output: {}, status: 'succeeded' };
      },
    };

    await createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      context(),
    );

    expect(calls.bindings).toEqual([binding]);
    expect(calls.connectionFences).toEqual([
      {
        connectionId: '11111111-1111-4111-8111-111111111111',
        expectedProviderKey: 'email',
        expectedAuthType: 'resend_api_key',
        secretVersionId: '22222222-2222-4222-8222-222222222222',
      },
    ]);
  });

  it.each([
    ['connection_fence_failed', 'provider_connection_fence_failed'],
    ['dispatch_binding_mismatch', 'provider_dispatch_binding_mismatch'],
  ] as const)(
    'maps the durable %s code to dispatch evidence',
    async (durableCode, evidenceCode) => {
      const { store } = fakeStore();
      const failure = new PreviewAttemptStateError(durableCode);
      const invoker: PreviewNodeInvoker = {
        invoke: async ({ runtime }) => {
          await runtime?.beforeDispatch();
          return { output: {}, status: 'succeeded' };
        },
      };
      await expect(
        createPreviewAttemptHandler(
          deps(
            {
              ...store,
              markDispatched: () => Promise.reject(failure),
            },
            invoker,
          ),
        ).handle(deliveryFixture(), context()),
      ).rejects.toEqual(new NodeDispatchEvidenceError(evidenceCode));
    },
  );

  it('does not trust an arbitrary same-code dispatch rejection', async () => {
    const { store } = fakeStore();
    const impostor = Object.assign(new Error('not durable'), {
      code: 'connection_fence_failed',
    });
    const invoker: PreviewNodeInvoker = {
      invoke: async ({ runtime }) => {
        await runtime?.beforeDispatch();
        return { output: {}, status: 'succeeded' };
      },
    };
    await expect(
      createPreviewAttemptHandler(
        deps(
          { ...store, markDispatched: () => Promise.reject(impostor) },
          invoker,
        ),
      ).handle(deliveryFixture(), context()),
    ).rejects.toBe(impostor);
  });

  it.each(['duplicate', 'rejected'] as const)(
    'does not emit terminal telemetry when completion is %s',
    async (completion) => {
      const { store } = fakeStore();
      const completionFailure = new Error('completion failed');
      const complete: PreviewAttemptRunStore['complete'] =
        completion === 'duplicate'
          ? () => Promise.resolve({ kind: 'duplicate' })
          : () => Promise.reject(completionFailure);
      const recordTerminal = vi.fn();
      const pending = createPreviewAttemptHandler({
        ...deps({ ...store, complete }, succeededInvoker({ ok: true }).invoker),
        telemetry: { recordReconciliation: vi.fn(), recordTerminal },
      }).handle(deliveryFixture(), context());

      if (completion === 'duplicate')
        await expect(pending).resolves.toEqual({ kind: 'duplicate' });
      else await expect(pending).rejects.toBe(completionFailure);
      expect(recordTerminal).not.toHaveBeenCalled();
    },
  );

  it('keeps committed connection telemetry diagnostic-only', async () => {
    const lease = {
      ...leaseFixture(),
      executableNode: {
        ...leaseFixture().executableNode,
        connectionRefs: { primary: randomUUID() },
      },
    };
    const { store } = fakeStore({ lease });
    const recordTerminal = vi.fn(() => {
      throw new Error('metrics failed');
    });

    await expect(
      createPreviewAttemptHandler({
        ...deps(store, succeededInvoker({ ok: true }).invoker),
        telemetry: { recordReconciliation: vi.fn(), recordTerminal },
      }).handle(deliveryFixture(), context()),
    ).resolves.toEqual({ kind: 'committed' });
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ usesConnection: true }),
    );
  });

  it('propagates infrastructure failures for bounded queue retries', async () => {
    const { calls, store } = fakeStore();
    const invoker: PreviewNodeInvoker = {
      invoke: () => Promise.reject(new Error('redis connection lost')),
    };
    await expect(
      createPreviewAttemptHandler(deps(store, invoker)).handle(
        deliveryFixture(),
        context(),
      ),
    ).rejects.toThrow('redis connection lost');
    expect(calls.completions).toHaveLength(0);
  });

  it('fails invalid executor outputs without partial success', async () => {
    const { calls, store } = fakeStore();
    // A function member can never satisfy the strict stored-value contract.
    const { invoker } = succeededInvoker({
      broken: (): number => 1,
    });
    const queueContext = context();
    await createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      queueContext,
    );
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.output_invalid',
      status: 'failed',
    });
    expect(calls.completionSignals).toEqual([queueContext.signal]);
  });

  it('completes timed_out when the durable execution deadline passes', async () => {
    const { calls, store } = fakeStore({
      beat: { runExecutionDeadlineAt: new Date(Date.now() - 1) },
    });
    const invoker: PreviewNodeInvoker = {
      invoke: ({ signal }) =>
        new Promise<PreviewInvocationOutcome>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    };
    const queueContext = context();
    const result = await createPreviewAttemptHandler(
      deps(store, invoker),
    ).handle(deliveryFixture(), queueContext);
    expect(result).toEqual({ kind: 'committed' });
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.deadline_exceeded',
      status: 'timed_out',
    });
    expect(calls.completionSignals).toEqual([queueContext.signal]);
    expect(queueContext.signal.aborted).toBe(false);
  });

  it('does not invoke work after the durable deadline already expired', async () => {
    const { calls, store } = fakeStore({
      lease: {
        ...leaseFixture(),
        executionDeadlineAt: new Date(Date.now() - 1),
      },
    });
    const invoke = vi.fn();
    const queueContext = context();
    await createPreviewAttemptHandler(deps(store, { invoke })).handle(
      deliveryFixture(),
      queueContext,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.deadline_exceeded',
      status: 'timed_out',
    });
    expect(calls.completionSignals).toEqual([queueContext.signal]);
  });

  it('records unknown when an unsafe dispatch crosses its deadline', async () => {
    vi.useFakeTimers();
    try {
      const { calls, store } = fakeStore({
        lease: {
          ...leaseFixture(),
          executionDeadlineAt: new Date(Date.now() + 100),
          mayCauseExternalSideEffect: true,
          sideEffectClass: 'unsafe',
        },
      });
      const dispatchStarted = Promise.withResolvers<undefined>();
      const invoker: PreviewNodeInvoker = {
        invoke: async ({ runtime, signal }) => {
          await runtime?.beforeDispatch();
          dispatchStarted.resolve(undefined);
          return new Promise<PreviewInvocationOutcome>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        },
      };
      const queueContext = context();
      const pending = createPreviewAttemptHandler(deps(store, invoker)).handle(
        deliveryFixture(),
        queueContext,
      );
      await dispatchStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(calls.dispatches).toBe(1);
      expect(calls.completions[0]).toMatchObject({
        safeErrorCode: 'preview.outcome_unknown',
        status: 'outcome_unknown',
      });
      expect(calls.completionSignals).toEqual([queueContext.signal]);
      expect(queueContext.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not terminalize after transport cancellation revokes the delivery', async () => {
    const { calls, store } = fakeStore();
    const controller = new AbortController();
    const reason = new Error('queue delivery revoked');
    const invoker: PreviewNodeInvoker = {
      invoke: ({ signal }) =>
        new Promise<PreviewInvocationOutcome>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(reason);
            },
            { once: true },
          );
        }),
    };
    const pending = createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      { signal: controller.signal },
    );

    await vi.waitFor(() => {
      expect(calls.claims).toBe(1);
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls.completions).toHaveLength(0);
  });

  it('does not begin invocation after transport authority is already revoked', async () => {
    const { calls, store } = fakeStore();
    const invoke = vi.fn();
    const controller = new AbortController();
    const reason = new Error('queue delivery already revoked');
    controller.abort(reason);

    await expect(
      createPreviewAttemptHandler(deps(store, { invoke })).handle(
        deliveryFixture(),
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(invoke).not.toHaveBeenCalled();
    expect(calls.completions).toHaveLength(0);
  });

  it('retains cancellation-ignoring invocation work after transport revocation', async () => {
    const { calls, store } = fakeStore();
    const controller = new AbortController();
    const invocationStarted = Promise.withResolvers<undefined>();
    const finishInvocation = Promise.withResolvers<PreviewInvocationOutcome>();
    const invoker: PreviewNodeInvoker = {
      invoke: () => {
        invocationStarted.resolve(undefined);
        return finishInvocation.promise;
      },
    };
    const pending = createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      { signal: controller.signal },
    );
    await invocationStarted.promise;
    const reason = new Error('queue delivery revoked');
    controller.abort(reason);

    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls.completions).toHaveLength(0);
    finishInvocation.resolve({ output: { late: true }, status: 'succeeded' });
    await expect(pending).rejects.toBe(reason);
    expect(calls.completions).toHaveLength(0);
  });

  it('commits deadline truth before draining cancellation-ignoring invocation work', async () => {
    vi.useFakeTimers();
    try {
      const { calls, store } = fakeStore({
        lease: {
          ...leaseFixture(),
          executionDeadlineAt: new Date(Date.now() + 100),
        },
      });
      const invocationStarted = Promise.withResolvers<undefined>();
      const finishInvocation =
        Promise.withResolvers<PreviewInvocationOutcome>();
      const invoker: PreviewNodeInvoker = {
        invoke: () => {
          invocationStarted.resolve(undefined);
          return finishInvocation.promise;
        },
      };
      const pending = createPreviewAttemptHandler(deps(store, invoker)).handle(
        deliveryFixture(),
        context(),
      );
      await invocationStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => {
        expect(calls.completions).toHaveLength(1);
      });
      expect(calls.completions[0]).toMatchObject({
        safeErrorCode: 'preview.deadline_exceeded',
        status: 'timed_out',
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      finishInvocation.resolve({ output: { late: true }, status: 'succeeded' });
      await expect(pending).resolves.toEqual({ kind: 'committed' });
      expect(calls.completions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit provider work when the deadline wins during dispatch marking', async () => {
    vi.useFakeTimers();
    try {
      const { calls, store } = fakeStore({
        lease: {
          ...leaseFixture(),
          executionDeadlineAt: new Date(Date.now() + 100),
          mayCauseExternalSideEffect: true,
          sideEffectClass: 'unsafe',
        },
      });
      const markerStarted = Promise.withResolvers<AbortSignal>();
      const finishMarker = Promise.withResolvers<'committed'>();
      const markDispatched: PreviewAttemptRunStore['markDispatched'] = vi.fn(
        (input: Parameters<PreviewAttemptRunStore['markDispatched']>[0]) => {
          const { signal } = input;
          if (signal === undefined)
            return Promise.reject(new Error('execution signal missing'));
          calls.dispatches += 1;
          markerStarted.resolve(signal);
          return finishMarker.promise;
        },
      );
      const providerCall = vi.fn();
      const invoker: PreviewNodeInvoker = {
        invoke: async ({ runtime }) => {
          await runtime?.beforeDispatch();
          providerCall();
          return { output: {}, status: 'succeeded' };
        },
      };
      const pending = createPreviewAttemptHandler(
        deps({ ...store, markDispatched }, invoker),
      ).handle(deliveryFixture(), context());
      const executionSignal = await markerStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(executionSignal.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(calls.completions).toHaveLength(1);
      });
      expect(calls.completions[0]).toMatchObject({
        safeErrorCode: 'preview.deadline_exceeded',
        status: 'timed_out',
      });

      finishMarker.resolve('committed');
      await expect(pending).resolves.toEqual({ kind: 'committed' });
      expect(providerCall).not.toHaveBeenCalled();
      expect(calls.completions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not manufacture cancellation after heartbeat authority fails', async () => {
    const heartbeatError = new Error('database heartbeat failed');
    const { calls, store } = fakeStore({ heartbeatError });
    const invoker: PreviewNodeInvoker = {
      invoke: ({ signal }) =>
        new Promise<PreviewInvocationOutcome>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    };
    await expect(
      createPreviewAttemptHandler(deps(store, invoker)).handle(
        deliveryFixture(),
        context(),
      ),
    ).rejects.toBe(heartbeatError);
    expect(calls.completions).toHaveLength(0);
  });

  it('rejects duplicate dispatch markers before a second external call', async () => {
    const { calls, store } = fakeStore();
    const invoker: PreviewNodeInvoker = {
      invoke: async ({ runtime }) => {
        await runtime?.beforeDispatch();
        await runtime?.beforeDispatch();
        return { output: {}, status: 'succeeded' };
      },
    };
    await expect(
      createPreviewAttemptHandler(deps(store, invoker)).handle(
        deliveryFixture(),
        context(),
      ),
    ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
    expect(calls.dispatches).toBe(1);
    expect(calls.completions).toHaveLength(0);
  });

  it('reserves dispatch permission before the marker await settles', async () => {
    const { calls, store } = fakeStore();
    const markerStarted = Promise.withResolvers<undefined>();
    const finishMarker = Promise.withResolvers<'committed'>();
    const markDispatched = vi.fn(() => {
      calls.dispatches += 1;
      markerStarted.resolve(undefined);
      return finishMarker.promise;
    });
    const invoker: PreviewNodeInvoker = {
      invoke: async ({ runtime }) => {
        const first = runtime?.beforeDispatch();
        await markerStarted.promise;
        const second = runtime?.beforeDispatch();
        finishMarker.resolve('committed');
        await first;
        await second;
        return { output: {}, status: 'succeeded' };
      },
    };

    await expect(
      createPreviewAttemptHandler(
        deps({ ...store, markDispatched }, invoker),
      ).handle(deliveryFixture(), context()),
    ).rejects.toBeInstanceOf(PreviewAttemptHandlerStateError);
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(calls.dispatches).toBe(1);
    expect(calls.completions).toHaveLength(0);
  });
});
