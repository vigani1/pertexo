import { describe, expect, it, vi } from 'vitest';

import {
  ApiDrainState,
  ApiShutdownCoordinator,
} from '../../src/platform/health/drain-state.js';

describe('API shutdown coordination', () => {
  it('drains first and attempts every owner in reverse acquisition order', async () => {
    const drain = new ApiDrainState();
    const shutdown = new ApiShutdownCoordinator(drain);
    const events: string[] = [];
    const synchronousFailure = new Error('middle sync failure');
    const asynchronousFailure = new Error('early async failure');

    shutdown.register('early', () => {
      expect(drain.isDraining()).toBe(true);
      events.push('early');
      return Promise.reject(asynchronousFailure);
    });
    shutdown.register('middle', () => {
      expect(drain.isDraining()).toBe(true);
      events.push('middle');
      throw synchronousFailure;
    });
    shutdown.register('late', () => {
      expect(drain.isDraining()).toBe(true);
      events.push('late');
      // Rejections can originate in non-TypeScript dependencies.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(undefined);
    });

    await expect(shutdown.close()).resolves.toBeUndefined();
    expect(events).toEqual(['late', 'middle', 'early']);
    expect(() => {
      shutdown.throwIfFailed();
    }).toThrow(
      expect.objectContaining({
        errors: [undefined, synchronousFailure, asynchronousFailure],
      }),
    );
  });

  it('shares one held completion and closes every owner exactly once', async () => {
    const drain = new ApiDrainState();
    const shutdown = new ApiShutdownCoordinator(drain);
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = vi.fn().mockResolvedValue(undefined);
    const last = vi.fn(() => {
      markStarted?.();
      return held;
    });
    shutdown.register('first', first);
    shutdown.register('last', last);

    const closeOne = shutdown.close();
    const closeTwo = shutdown.close();
    expect(closeTwo).toBe(closeOne);
    await started;
    expect(last).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    release?.();
    await expect(closeOne).resolves.toBeUndefined();
    expect(first).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
  });

  it('surfaces recorded failures from signal-driven shutdown', async () => {
    const failure = new Error('resource close failed');
    const shutdown = new ApiShutdownCoordinator(new ApiDrainState());
    shutdown.register('resource', () => Promise.reject(failure));

    const result = await shutdown
      .onApplicationShutdown('SIGTERM')
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([failure]);
  });
});
