import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publicationRetryDelay } from '../../../src/transport/outbox/dispatch/delivery.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { transportMetrics } from '../../support/transport/metrics.js';
import { boundaries, createDispatcher, event } from './fixture.js';

describe('the delay before publishing again', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [5, 16_000],
    [6, 30_000],
    [10_000, 30_000],
  ])('after %i attempts is %i ms', (attempts, delay) => {
    expect(publicationRetryDelay(1_000, attempts)).toBe(delay);
  });
});

// backend-gaps-01: an outage of any length is worth waiting out. Nothing but a
// broken row may ever end an event, and a count of failures isn't one.
describe('a publication Redis refused', () => {
  const NOW = new Date('2026-10-31T00:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [1, 1_000],
    [6, 30_000],
    [10_000, 30_000],
  ])(
    'after %i attempts goes back to wait %i ms, never to fail',
    async (publishAttempts, delay) => {
      const selected = boundaries([event({ publishAttempts })]);
      vi.mocked(selected.producer.publish).mockRejectedValue(
        new Error('OOM command not allowed when used memory > maxmemory'),
      );
      const dispatcher = createDispatcher({
        boundaries: selected,
        drainState: new WorkerDrainState(),
        metrics: transportMetrics(),
      });

      await dispatcher.dispatchOnce();

      expect(selected.database.releaseOrFail).toHaveBeenCalledWith(
        expect.objectContaining({
          disposition: 'retry',
          retryAt: new Date(NOW.getTime() + delay),
        }),
      );
    },
  );
});
