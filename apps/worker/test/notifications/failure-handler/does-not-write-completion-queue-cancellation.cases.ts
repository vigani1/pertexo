import { expect, it, vi } from 'vitest';
import type { FailureNotificationDeliveryCapability } from '../../../src/notifications/failure-handler.js';

import { createFailureNotificationHandler } from '../../../src/notifications/failure-handler.js';
import { delivery, store, readyDeliveryResult } from './fixture.js';

export function registerDoesNotWriteCompletionQueueCancellation(): void {
  it('does not write completion when queue cancellation follows provider settlement', async () => {
    const repository = store();
    const controller = new AbortController();
    const providerThenable = {
      then: (
        resolve: (value: ReturnType<typeof readyDeliveryResult>) => void,
      ) => {
        resolve(readyDeliveryResult());
        controller.abort(
          new Error('worker stopping after provider settlement'),
        );
      },
    };
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi.fn<FailureNotificationDeliveryCapability['deliver']>(
          () =>
            providerThenable as unknown as Promise<
              ReturnType<typeof readyDeliveryResult>
            >,
        ),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await expect(
      handler.handle(delivery, { signal: controller.signal }),
    ).resolves.toBeUndefined();
    expect(repository.completeDelivery).not.toHaveBeenCalled();
  });

  it('bounds provider work when cancellation precedes settlement registration', async () => {
    const repository = store();
    const controller = new AbortController();
    const provider =
      Promise.withResolvers<ReturnType<typeof readyDeliveryResult>>();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi.fn<FailureNotificationDeliveryCapability['deliver']>(() => {
          controller.abort(new Error('worker stopping before provider wait'));
          return provider.promise;
        }),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await expect(
      handler.handle(delivery, { signal: controller.signal }),
    ).resolves.toBeUndefined();
    expect(repository.completeDelivery).not.toHaveBeenCalled();
    expect(handler.pendingOperations()).toHaveLength(1);

    provider.resolve(readyDeliveryResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(handler.pendingOperations()).toHaveLength(0);
  });

  it('records provider timeout as retry with unresolved dispatch evidence', async () => {
    const repository = store();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      },
      timeoutMillis: 5,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });
    const queueContext = { signal: new AbortController().signal };
    await handler.handle(delivery, queueContext);
    expect(repository.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          kind: 'retry',
          safeErrorCode: 'delivery.timeout',
          possiblyDispatched: true,
        },
        signal: queueContext.signal,
      }),
    );
  });

  it.each(['resolve', 'reject'] as const)(
    'settles an ignored timeout and observes a late provider %s without a terminal write',
    async (outcome) => {
      const repository = store();
      const provider =
        Promise.withResolvers<ReturnType<typeof readyDeliveryResult>>();
      let observedSignal: AbortSignal | undefined;
      const handler = createFailureNotificationHandler({
        store: repository,
        delivery: {
          deliver: vi.fn<FailureNotificationDeliveryCapability['deliver']>(
            ({ signal }) => {
              observedSignal = signal;
              return provider.promise;
            },
          ),
        },
        timeoutMillis: 5,
        maxAttempts: 3,
        retryDelaySeconds: 1,
      });

      await expect(
        handler.handle(delivery, {
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
      expect(observedSignal?.aborted).toBe(true);
      expect(repository.completeDelivery).not.toHaveBeenCalled();
      expect(handler.pendingOperations()).toHaveLength(1);

      if (outcome === 'resolve') provider.resolve(readyDeliveryResult());
      else provider.reject(new Error('late provider rejection'));
      await Promise.resolve();
      await Promise.resolve();
      expect(handler.pendingOperations()).toHaveLength(0);
      expect(repository.completeDelivery).not.toHaveBeenCalled();
    },
  );

  it('removes its queue abort listener once the delivery settles', async () => {
    const repository = store();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi
          .fn<FailureNotificationDeliveryCapability['deliver']>()
          .mockResolvedValue({
            kind: 'delivered',
            possiblyDispatched: true,
          }),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await handler.handle(delivery, { signal: controller.signal });
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), {
      once: true,
    });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cancels a deferred terminal write with the transport signal', async () => {
    const repository = store();
    const controller = new AbortController();
    const reason = new Error('worker stopping during completion');
    vi.mocked(repository.completeDelivery).mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(reason);
            },
            { once: true },
          );
        }),
    );
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi
          .fn<FailureNotificationDeliveryCapability['deliver']>()
          .mockResolvedValue({
            kind: 'delivered',
            possiblyDispatched: true,
            providerReference: 'opaque-ref',
          }),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });
    const pending = handler.handle(delivery, { signal: controller.signal });

    await vi.waitFor(() => {
      expect(repository.completeDelivery).toHaveBeenCalledOnce();
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(
      vi.mocked(repository.completeDelivery).mock.calls[0]?.[0].signal,
    ).toBe(controller.signal);
  });
}
