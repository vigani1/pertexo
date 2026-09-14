import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boundedBackgroundTask } from '../src/runtime/background-task-deadline.js';

describe('bounded background task settlement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves fulfillment and clears the deadline timer', async () => {
    await expect(
      boundedBackgroundTask(Promise.resolve('complete'), 100),
    ).resolves.toBe('complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an undefined task rejection and clears the timer', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- hostile legacy boundary regression
    const task = Promise.reject(undefined);

    await expect(boundedBackgroundTask(task, 100)).rejects.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'rejection'] as const)(
    'observes late task %s after reporting its wait timeout',
    async (settlement) => {
      const task = Promise.withResolvers<string>();
      const bounded = boundedBackgroundTask(task.promise, 100);
      const outcome = bounded.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(100);
      await expect(outcome).resolves.toMatchObject({
        name: 'BackgroundTaskShutdownTimeoutError',
      });
      if (settlement === 'success') task.resolve('late');
      else task.reject(new Error('late task failure'));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
