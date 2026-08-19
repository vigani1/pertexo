import { describe, expect, it } from 'vitest';

import { QUEUE_CLASS_DEFAULTS } from '../src/defaults.js';
import { QUEUE_NAME } from '../src/names.js';

describe('queue-class defaults', () => {
  it('defines transport-only retry and bounded retention for every queue', () => {
    for (const queueName of Object.values(QUEUE_NAME)) {
      const defaults = QUEUE_CLASS_DEFAULTS[queueName];

      expect(defaults.attempts).toBeGreaterThan(1);
      expect(defaults.backoff).toEqual({ type: 'fixed', delay: 1_000 });
      expect(defaults.lockDurationMs).toBeGreaterThan(0);
      expect(defaults.heartbeatIntervalMs).toBeGreaterThan(0);
      expect(defaults.heartbeatIntervalMs).toBeLessThan(
        defaults.lockDurationMs,
      );
      expect(defaults.stalledIntervalMs).toBeGreaterThan(0);
      expect(defaults.maxStalledCount).toBeGreaterThan(0);
      expect(defaults.timeoutMs).toBeGreaterThan(defaults.lockDurationMs);
      expect(defaults.concurrency).toBeGreaterThan(0);
      expect(defaults.drainTimeoutMs).toBeGreaterThan(0);
      expect(defaults.removeOnComplete.age).toBeGreaterThan(0);
      expect(defaults.removeOnComplete.count).toBeGreaterThan(0);
      expect(defaults.removeOnFail.age).toBeGreaterThan(
        defaults.removeOnComplete.age,
      );
      expect(defaults.removeOnFail.count).toBeGreaterThan(
        defaults.removeOnComplete.count,
      );
    }
  });

  it('keeps queue defaults immutable at runtime', () => {
    expect(Object.isFrozen(QUEUE_CLASS_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(QUEUE_CLASS_DEFAULTS[QUEUE_NAME.maintenance])).toBe(
      true,
    );
  });
});
