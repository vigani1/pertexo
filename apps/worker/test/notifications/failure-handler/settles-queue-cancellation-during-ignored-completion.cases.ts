import { expect, it, vi } from 'vitest';

import { createFailureNotificationHandler } from '../../../src/notifications/failure-handler.js';
import { delivery, store, readyDeliveryResult } from './fixture.js';

export function registerSettlesQueueCancellationDuringIgnoredCompletion(): void {
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
}
