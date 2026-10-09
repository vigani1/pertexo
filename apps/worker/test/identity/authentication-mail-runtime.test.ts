import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthenticationMailRuntime } from '../../src/identity/authentication-mail-runtime.js';

function store(close = vi.fn(() => Promise.resolve())) {
  return { claim: vi.fn(), settle: vi.fn(), close };
}

describe('authentication mail runtime', () => {
  afterEach(() => vi.useRealTimers());

  it('is ready after a delivery cycle and unready after a failed one until the next succeeds', async () => {
    vi.useFakeTimers();
    const runOnce = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('decryption failed'))
      .mockResolvedValue(0);
    const onFailure = vi.fn();
    const runtime = createAuthenticationMailRuntime(
      { runOnce },
      store(),
      100,
      onFailure,
    );
    try {
      runtime.start();
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(100);
      expect(onFailure).toHaveBeenCalledOnce();
      await expect(runtime.checkReadiness()).rejects.toThrow(
        'Authentication mail latest cycle failed',
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(runOnce).toHaveBeenCalledTimes(3);
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('stops delivering and closes its store once', async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn(() => Promise.resolve(0));
    const close = vi.fn(() => Promise.resolve());
    const runtime = createAuthenticationMailRuntime(
      { runOnce },
      store(close),
      100,
      vi.fn(),
    );
    runtime.start();
    await runtime.checkReadiness();

    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    await vi.advanceTimersByTimeAsync(500);

    expect(runOnce).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(runtime.checkReadiness()).rejects.toThrow(
      'Authentication mail runtime is closed',
    );
  });

  it('reports a store close failure', async () => {
    const failure = new Error('store close failed');
    const runtime = createAuthenticationMailRuntime(
      { runOnce: () => Promise.resolve(0) },
      store(vi.fn(() => Promise.reject(failure))),
      100,
      vi.fn(),
    );

    await expect(runtime.close()).rejects.toBe(failure);
  });
});
