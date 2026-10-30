import type { ApiRateLimit } from '../../src/platform/rate-limit/module.js';

/** The rate-limit service for a test that needs no Redis behind its consumer. */
export function fakeRateLimit(
  consumer: Pick<ApiRateLimit, 'consume'>,
): ApiRateLimit {
  return {
    consume: (decision) => consumer.consume(decision),
    acquireExclusiveSlot: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
}
