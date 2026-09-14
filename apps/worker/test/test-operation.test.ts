import { describe, expect, it, vi } from 'vitest';

import { runWithCleanup } from './support/test-operation.js';

describe('runWithCleanup', () => {
  it('returns the operation value after cleanup settles', async () => {
    const cleanup = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      runWithCleanup(() => Promise.resolve('value'), cleanup, 'fixture'),
    ).resolves.toBe('value');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('preserves an Error operation failure after successful cleanup', async () => {
    const failure = new Error('operation failed');

    await expect(
      runWithCleanup(
        () => Promise.reject(failure),
        () => Promise.resolve(),
        'fixture',
      ),
    ).rejects.toBe(failure);
  });

  it('surfaces a cleanup failure after a successful operation', async () => {
    const failure = new Error('cleanup failed');

    await expect(
      runWithCleanup(
        () => Promise.resolve(),
        () => Promise.reject(failure),
        'fixture',
      ),
    ).rejects.toBe(failure);
  });

  it('preserves the primary failure before every flattened cleanup failure', async () => {
    const primary = new Error('primary');
    const cleanupOne = new Error('cleanup one');
    const cleanupTwo = new Error('cleanup two');

    const result = await runWithCleanup(
      () => Promise.reject(primary),
      () =>
        Promise.reject(
          new AggregateError([cleanupOne, cleanupTwo], 'cleanup failed'),
        ),
      'fixture',
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      primary,
      cleanupOne,
      cleanupTwo,
    ]);
  });

  it('normalizes a sole non-Error rejection into a throwable Error', async () => {
    const result = await runWithCleanup(
      // Deliberately proves normalization of a hostile non-Error rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject(undefined),
      () => Promise.resolve(),
      'fixture',
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).cause).toBeUndefined();
    expect((result as Error).message).toBe('fixture: operation failed');
  });
});
