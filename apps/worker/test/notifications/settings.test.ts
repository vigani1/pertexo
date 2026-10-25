import { describe, expect, it } from 'vitest';
import { createFailureNotificationHandler } from '../../src/notifications/failure-handler.js';

function settings(override: Record<string, number>) {
  return {
    store: {} as Parameters<
      typeof createFailureNotificationHandler
    >[0]['store'],
    delivery: {
      deliver: () =>
        Promise.resolve({
          kind: 'delivered' as const,
          possiblyDispatched: true as const,
        }),
    },
    timeoutMillis: 10_000,
    maxAttempts: 3,
    retryDelaySeconds: 30,
    ...override,
  };
}
describe('failure notification worker settings boundary', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 11])(
    'rejects maximum attempts %s at startup',
    (value) => {
      expect(() =>
        createFailureNotificationHandler(settings({ maxAttempts: value })),
      ).toThrow();
    },
  );
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 3601])(
    'rejects retry delay %s at startup',
    (value) => {
      expect(() =>
        createFailureNotificationHandler(
          settings({ retryDelaySeconds: value }),
        ),
      ).toThrow();
    },
  );
  it('keeps zero terminal retry delay and the maximum retry settings', () => {
    expect(() =>
      createFailureNotificationHandler(
        settings({ maxAttempts: 10, retryDelaySeconds: 0 }),
      ),
    ).not.toThrow();
    expect(() =>
      createFailureNotificationHandler(
        settings({ maxAttempts: 1, retryDelaySeconds: 3600 }),
      ),
    ).not.toThrow();
  });
  it('bounds the timeout so the derived recovery window fits within one hour', () => {
    expect(() =>
      createFailureNotificationHandler(settings({ timeoutMillis: 3_599_001 })),
    ).toThrow();
  });
});
