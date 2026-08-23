import { randomUUID } from 'node:crypto';

import { jobIdForOutboxEvent } from '@pertexo/queue';
import type {
  PreviewAttemptLease,
  PreviewTerminalOutcome,
} from '@pertexo/database';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewAttemptHandler,
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
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
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
  } as unknown as PreviewAttemptLease;
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
    transport: { jobId: jobIdForOutboxEvent(outboxEventId) },
  } as never;
}

function context(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

interface StoreCalls {
  claims: number;
  completions: PreviewTerminalOutcome[];
  dispatches: number;
}

function fakeStore(
  overrides: Partial<{
    beat: { runExpiresAt: Date };
    claimKind: 'duplicate';
    heartbeatError: Error;
    lease: PreviewAttemptLease;
  }> = {},
): { calls: StoreCalls; store: PreviewAttemptRunStore } {
  const calls: StoreCalls = {
    claims: 0,
    completions: [],
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
    complete: ({ outcome }) => {
      calls.completions.push(outcome);
      return Promise.resolve({ kind: 'committed' });
    },
    heartbeat: () => {
      if (overrides.heartbeatError !== undefined)
        return Promise.reject(overrides.heartbeatError);
      const beat = overrides.beat ?? {
        runExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      };
      return Promise.resolve({
        attemptLeaseExpiresAt: new Date(Date.now() + 30 * 1_000),
        runExpiresAt: beat.runExpiresAt,
      });
    },
    markDispatched: () => {
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
  it('wraps raw executor output into the stored envelope and commits truthfully', async () => {
    const { calls, store } = fakeStore();
    const { invoker } = succeededInvoker({ ok: true });
    const recordTerminal = vi.fn();
    const result = await createPreviewAttemptHandler({
      ...deps(store, invoker),
      telemetry: { recordReconciliation: vi.fn(), recordTerminal },
    }).handle(deliveryFixture(), context());
    expect(result).toEqual({ kind: 'committed' });
    expect(calls.claims).toBe(1);
    expect(calls.completions[0]?.status).toBe('succeeded');
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

  it('passes the durable preview deadline to the artifact capability', async () => {
    const lease = leaseFixture();
    const { store } = fakeStore({ lease });
    const artifactFactory = vi.fn(() => ({ write: vi.fn() }));
    const invoker: PreviewNodeInvoker = {
      invoke: ({ runtime }) => {
        expect(runtime?.artifacts).toBeDefined();
        return Promise.resolve({ output: { ok: true }, status: 'succeeded' });
      },
    };

    await createPreviewAttemptHandler({
      ...deps(store, invoker),
      runtimeCapabilities: { artifacts: artifactFactory },
    }).handle(deliveryFixture(), context());

    expect(artifactFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactRetentionDeadline: lease.expiresAt,
        previewAttemptId,
        previewRunId,
      }),
    );
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

  it('rejects a transport identity mismatch before any durable work', async () => {
    const { calls, store } = fakeStore();
    const forged = deliveryFixture() as { transport: { jobId: string } };
    forged.transport.jobId = jobIdForOutboxEvent(randomUUID());
    await expect(
      createPreviewAttemptHandler(
        deps(store, succeededInvoker({}).invoker),
      ).handle(forged as never, context()),
    ).rejects.toMatchObject({ code: 'transport_identity_mismatch' });
    expect(calls.claims).toBe(0);
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
    await createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      context(),
    );
    expect(calls.completions[0]).toMatchObject(expected);
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
    await createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      context(),
    );
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.output_invalid',
      status: 'failed',
    });
  });

  it('completes timed_out when the durable retention deadline passes', async () => {
    const { calls, store } = fakeStore({
      beat: { runExpiresAt: new Date(Date.now() - 1) },
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
    const result = await createPreviewAttemptHandler(
      deps(store, invoker),
    ).handle(deliveryFixture(), context());
    expect(result).toEqual({ kind: 'committed' });
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.deadline_exceeded',
      status: 'timed_out',
    });
  });

  it('does not invoke work after the durable deadline already expired', async () => {
    const { calls, store } = fakeStore({
      lease: {
        ...leaseFixture(),
        expiresAt: new Date(Date.now() - 1),
      },
    });
    const invoke = vi.fn();
    await createPreviewAttemptHandler(deps(store, { invoke })).handle(
      deliveryFixture(),
      context(),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.deadline_exceeded',
      status: 'timed_out',
    });
  });

  it('records unknown when an unsafe dispatch crosses its deadline', async () => {
    const { calls, store } = fakeStore({
      lease: {
        ...leaseFixture(),
        expiresAt: new Date(Date.now() + 40),
        mayCauseExternalSideEffect: true,
        sideEffectClass: 'unsafe',
      },
    });
    const invoker: PreviewNodeInvoker = {
      invoke: async ({ runtime, signal }) => {
        await runtime?.beforeDispatch();
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
    await createPreviewAttemptHandler(deps(store, invoker)).handle(
      deliveryFixture(),
      context(),
    );
    expect(calls.dispatches).toBe(1);
    expect(calls.completions[0]).toMatchObject({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
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
});
