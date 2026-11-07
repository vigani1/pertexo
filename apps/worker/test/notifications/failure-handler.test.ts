import { describe, expect, it, vi } from 'vitest';
import {
  createFailureNotificationHandler,
  type FailureNotificationDeliveryCapability,
} from '../../src/notifications/failure-handler.js';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import {
  context,
  delivery,
  readyClaim,
  store,
  readyDeliveryResult,
} from './failure-handler.fixture.js';

describe('failure notification handler', () => {
  it('delivers loaded immutable context and persists a bounded result', async () => {
    const repository = store();
    const deliver = vi.fn().mockResolvedValue({
      kind: 'delivered',
      possiblyDispatched: true,
      providerReference: 'opaque-ref',
    });
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: { deliver },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    const queueContext = { signal: new AbortController().signal };
    await handler.handle(delivery, queueContext);

    expect(deliver).toHaveBeenCalledWith({
      context,
      workspaceId: delivery.data.workspaceId,
      intentId: delivery.data.notificationIntentId,
      attemptNumber: 1,
      destinationId: readyClaim().destinationId,
      destinationConfigVersion: 2,
      idempotencyKey: readyClaim().idempotencyKey,
      sideEffectClass: 'idempotent_with_key',
      connectionSecretVersionId: readyClaim().connectionSecretVersionId,
      deliveryUnresolved: false,
      signal: expect.any(AbortSignal) as unknown,
    });
    expect(repository.claimDelivery).toHaveBeenCalledWith({
      workspaceId: delivery.data.workspaceId,
      intentId: delivery.data.notificationIntentId,
      delivery: {
        outboxEventId: delivery.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
      },
      recoverySeconds: 2,
      maxAttempts: 3,
      signal: queueContext.signal,
    });
    expect(repository.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ kind: 'delivered' }) as unknown,
        signal: queueContext.signal,
      }),
    );
  });

  it.each(['busy', 'terminal'] as const)(
    'makes a %s claim inert',
    async (kind) => {
      const repository = store();
      vi.mocked(repository.claimDelivery).mockResolvedValue({ kind });
      const deliver = vi.fn();
      const handler = createFailureNotificationHandler({
        store: repository,
        delivery: { deliver },
        timeoutMillis: 100,
        maxAttempts: 3,
        retryDelaySeconds: 1,
      });

      await handler.handle(delivery, {
        signal: new AbortController().signal,
      });
      expect(deliver).not.toHaveBeenCalled();
      expect(repository.completeDelivery).not.toHaveBeenCalled();
    },
  );

  it('makes duplicate terminal delivery inert', async () => {
    const repository = store('terminal');
    const deliver = vi.fn();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: { deliver },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });
    await handler.handle(delivery, { signal: new AbortController().signal });
    expect(deliver).not.toHaveBeenCalled();
    expect(repository.completeDelivery).not.toHaveBeenCalled();
  });

  it('does not start delivery when queue cancellation occurs during claim', async () => {
    const repository = store();
    let releaseClaim: (() => void) | undefined;
    vi.mocked(repository.claimDelivery).mockImplementation(
      () =>
        new Promise<ReturnType<typeof readyClaim>>((resolve) => {
          releaseClaim = () => {
            resolve(readyClaim());
          };
        }),
    );
    const deliver = vi.fn();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: { deliver },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });
    const controller = new AbortController();
    const pending = handler.handle(delivery, { signal: controller.signal });

    await vi.waitFor(() => {
      expect(releaseClaim).toBeTypeOf('function');
    });
    controller.abort(new Error('worker stopping'));
    expect(vi.mocked(repository.claimDelivery).mock.calls[0]?.[0].signal).toBe(
      controller.signal,
    );
    expect(
      vi.mocked(repository.claimDelivery).mock.calls[0]?.[0].signal?.aborted,
    ).toBe(true);
    await pending;

    expect(deliver).not.toHaveBeenCalled();
    expect(repository.completeDelivery).not.toHaveBeenCalled();
    expect(handler.pendingOperations()).toHaveLength(1);
    releaseClaim?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(handler.pendingOperations()).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not claim an already-aborted queue delivery', async () => {
    const repository = store();
    const controller = new AbortController();
    controller.abort(new Error('already stopping'));
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi.fn<FailureNotificationDeliveryCapability['deliver']>(),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await expect(
      handler.handle(delivery, { signal: controller.signal }),
    ).resolves.toBeUndefined();
    expect(repository.claimDelivery).not.toHaveBeenCalled();
  });

  it('preserves a claim persistence rejection', async () => {
    const repository = store();
    const rejection = { code: 'claim-unavailable' };
    vi.mocked(repository.claimDelivery).mockRejectedValue(rejection);
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi.fn<FailureNotificationDeliveryCapability['deliver']>(),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await expect(
      handler.handle(delivery, { signal: new AbortController().signal }),
    ).rejects.toBe(rejection);
    expect(repository.completeDelivery).not.toHaveBeenCalled();
  });

  it('maps a synchronous provider failure to a conservative retry', async () => {
    const repository = store();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: vi.fn<FailureNotificationDeliveryCapability['deliver']>(() => {
          throw new Error('synchronous provider failure');
        }),
      },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await handler.handle(delivery, {
      signal: new AbortController().signal,
    });

    expect(repository.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          kind: 'retry',
          safeErrorCode: 'delivery.provider_failure',
          possiblyDispatched: true,
        },
      }),
    );
  });

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

  it.each(['resolve', 'reject'] as const)(
    'settles queue cancellation during an ignored completion and observes its late %s',
    async (outcome) => {
      const repository = store();
      const completion = Promise.withResolvers<'completed'>();
      vi.mocked(repository.completeDelivery).mockReturnValue(
        completion.promise,
      );
      const handler = createFailureNotificationHandler({
        store: repository,
        delivery: { deliver: vi.fn().mockResolvedValue(readyDeliveryResult()) },
        timeoutMillis: 100,
        maxAttempts: 3,
        retryDelaySeconds: 1,
      });
      const controller = new AbortController();
      const pending = handler.handle(delivery, { signal: controller.signal });
      await vi.waitFor(() => {
        expect(repository.completeDelivery).toHaveBeenCalledOnce();
      });
      controller.abort(new Error('worker stopping'));
      await expect(pending).resolves.toBeUndefined();
      expect(handler.pendingOperations()).toHaveLength(1);

      if (outcome === 'resolve') completion.resolve('completed');
      else completion.reject(new Error('late completion rejection'));
      await Promise.resolve();
      await Promise.resolve();
      expect(handler.pendingOperations()).toHaveLength(0);
      expect(repository.completeDelivery).toHaveBeenCalledOnce();
    },
  );
});
