import { randomUUID } from 'node:crypto';
import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';

import { expect, it, vi } from 'vitest';
import {
  createPreviewAttemptHandler,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
} from '../../../src/previews/handler.js';
import {
  workspaceId,
  outboxEventId,
  previewRunId,
  previewAttemptId,
  leaseFixture,
  deliveryFixture,
  context,
  fakeStore,
  succeededInvoker,
  deps,
} from './fixture.js';

export function registerRetainsCodeDiagnosticsSafePreviewWithout(): void {
  it('retains Code diagnostics for a safe preview without an external dispatch', async () => {
    const { store, calls } = fakeStore({
      lease: {
        ...leaseFixture(),
        definitionKey: 'core.code',
        mayContactProvider: false,
      },
    });
    const diagnostics = {
      logs: [{ level: 'info' as const, message: 'private preview log' }],
      truncated: false,
    };
    const complete = vi.fn(
      (input: Parameters<PreviewAttemptRunStore['complete']>[0]) =>
        store.complete(input),
    );
    const invoker: PreviewNodeInvoker = {
      invoke: ({ runtime }) => {
        runtime?.observeCodeDiagnostics?.(diagnostics);
        return Promise.resolve({ status: 'succeeded', output: { value: 7 } });
      },
    };
    await createPreviewAttemptHandler(
      deps({ ...store, complete }, invoker),
    ).handle(deliveryFixture(), context());
    expect(calls.dispatches).toBe(0);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        codeDiagnostics: diagnostics,
        outcome: {
          status: 'succeeded',
          output: { kind: 'inline', value: { value: 7 } },
        },
      }),
    );
  });

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
      deadlineAt: lease.executionDeadlineAt,
      fenceToken: lease.attemptFenceToken,
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
        value: { body: { kind: 'artifact', artifactId } },
      },
      status: 'succeeded',
    });
  });
}
