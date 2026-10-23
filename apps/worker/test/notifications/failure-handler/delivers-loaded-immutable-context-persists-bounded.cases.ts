import { expect, it, vi } from 'vitest';
import type { FailureNotificationDeliveryCapability } from '../../../src/notifications/failure-handler.js';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import { createFailureNotificationHandler } from '../../../src/notifications/failure-handler.js';
import { context, delivery, readyClaim, store } from './fixture.js';

export function registerDeliversLoadedImmutableContextPersistsBounded(): void {
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
}
