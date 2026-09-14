import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bounded,
  TransportOperationTimeoutError,
} from '../src/transport/transport-operation-deadline.js';

/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- hostile and legacy values are the contract under test */

afterEach(() => {
  vi.useRealTimers();
});

describe('transport operation deadline', () => {
  it('settles with an exact hostile rejection without inspecting it', async () => {
    const hostile = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => {
        throw new Error('prototype inspection denied');
      },
    });

    await expect(bounded(Promise.reject(hostile), 100)).rejects.toBe(hostile);
  });

  it('preserves an undefined rejection exactly', async () => {
    const caught = await bounded(Promise.reject(undefined), 100).then(
      () => 'fulfilled' as const,
      (error: unknown) => error,
    );

    expect(caught).toBeUndefined();
  });

  it.each(['fulfills', 'rejects'] as const)(
    'observes a task that %s after its deadline without replacing timeout truth',
    async (settlement) => {
      vi.useFakeTimers();
      const task = Promise.withResolvers<string>();
      const result = bounded(task.promise, 10);
      const observed = result.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);
      await expect(observed).resolves.toBeInstanceOf(
        TransportOperationTimeoutError,
      );

      if (settlement === 'fulfills') task.resolve('late');
      else task.reject(new Error('late failure'));
      await Promise.resolve();
      await Promise.resolve();
    },
  );
});
