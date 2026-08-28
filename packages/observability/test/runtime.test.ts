import { describe, expect, it, vi } from 'vitest';

import { waitForAbortableDelay } from '../src/runtime.js';

describe('waitForAbortableDelay', () => {
  it('resolves after the requested delay', async () => {
    vi.useFakeTimers();
    try {
      const delayed = waitForAbortableDelay(250, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(249);
      let resolved = false;
      void delayed.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(delayed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves immediately when shutdown is requested', async () => {
    const controller = new AbortController();
    const delayed = waitForAbortableDelay(60_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(delayed).resolves.toBeUndefined();
  });
});
