import { expect, it, vi } from 'vitest';
import {
  createPreviewAttemptHandler,
  type PreviewInvocationOutcome,
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

export function registerPropagatesInfrastructureFailuresBoundedQueueRetries(): void {
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
}
