import { expect, it, vi } from 'vitest';
import {
  createPreviewAttemptHandler,
  PreviewAttemptHandlerStateError,
  type PreviewInvocationOutcome,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
} from '../../../src/previews/handler.js';
import {
  leaseFixture,
  deliveryFixture,
  context,
  fakeStore,
  deps,
} from './fixture.js';

export function registerCommitsDeadlineTruthBeforeDrainingCancellation(): void {
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
}
