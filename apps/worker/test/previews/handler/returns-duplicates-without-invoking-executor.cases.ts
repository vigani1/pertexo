import { randomUUID } from 'node:crypto';

import { PreviewAttemptStateError } from '@pertexo/core/previews';

import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';

import { expect, it, vi } from 'vitest';
import {
  createPreviewAttemptHandler,
  type PreviewInvocationOutcome,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
} from '../../../src/previews/handler.js';
import {
  leaseFixture,
  deliveryFixture,
  context,
  fakeStore,
  succeededInvoker,
  deps,
} from './fixture.js';

export function registerReturnsDuplicatesWithoutInvokingExecutor(): void {
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
    const binding = 'email:sha256:' + 'b'.repeat(64);
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
}
