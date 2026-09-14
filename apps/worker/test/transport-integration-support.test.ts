import { describe, expect, it, vi } from 'vitest';

import { createTransportTestCleanupStack } from './support/transport.integration.support.js';

describe('worker transport integration ownership', () => {
  it('attempts every owner in reverse acquisition order and reports all failures', async () => {
    const events: string[] = [];
    const cleanup = createTransportTestCleanupStack('injected fixture');
    const closeFirst = cleanup.add('first', () => {
      events.push('first');
    });
    cleanup.add('second', () => {
      events.push('second');
      throw new Error('second failed');
    });
    cleanup.add('third', () => {
      events.push('third');
      return Promise.reject(new Error('third failed'));
    });

    const error = await cleanup.close().catch((failure: unknown) => failure);

    expect(events).toEqual(['third', 'second', 'first']);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: 'injected fixture cleanup failed: third',
      }),
      expect.objectContaining({
        message: 'injected fixture cleanup failed: second',
      }),
    ]);
    await closeFirst();
    await cleanup.close();
    expect(events).toEqual(['third', 'second', 'first']);
  });

  it('caches a resource close before invoking a synchronous closer', async () => {
    const close = vi.fn(() => {
      throw new Error('synchronous close failure');
    });
    const cleanup = createTransportTestCleanupStack('cached fixture');
    const closeOnce = cleanup.add('resource', close);

    const first = closeOnce();
    const second = closeOnce();

    expect(first).toBe(second);
    await expect(first).rejects.toThrow('synchronous close failure');
    await expect(cleanup.close()).rejects.toThrow(
      'cached fixture cleanup failed',
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects ownership registration after cleanup starts', async () => {
    const cleanup = createTransportTestCleanupStack('closed fixture');
    await cleanup.close();

    expect(() => cleanup.add('late owner', () => undefined)).toThrow(
      'Cannot register late owner after closed fixture cleanup',
    );
  });
});
