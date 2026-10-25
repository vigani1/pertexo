import { describe, expect, it, vi } from 'vitest';
import { createFailureNotificationHandler } from '../../src/notifications/failure-handler.js';
import { delivery, store } from './failure-handler/fixture.js';

describe('notification delivery result boundary', () => {
  it('classifies an invalid provider result before writing a typed retry completion', async () => {
    const persistence = store();
    const handler = createFailureNotificationHandler({
      store: persistence,
      delivery: {
        deliver: vi
          .fn()
          .mockResolvedValue({ kind: 'delivered', possiblyDispatched: false }),
      },
      timeoutMillis: 1000,
      maxAttempts: 3,
      retryDelaySeconds: 30,
    });
    await handler.handle(delivery, { signal: new AbortController().signal });
    expect(persistence.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          kind: 'retry',
          possiblyDispatched: true,
          safeErrorCode: 'delivery.provider_failure',
        },
      }),
    );
  });
});
