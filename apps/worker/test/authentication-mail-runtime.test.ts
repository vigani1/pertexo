import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthenticationMailRuntime } from '../src/execution/authentication-mail-runtime.js';

describe('authentication mail runtime readiness', () => {
  afterEach(() => vi.useRealTimers());

  it('fails readiness after a delivery-cycle error and recovers only after a successful cycle', async () => {
    vi.useFakeTimers();
    const runOnce = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('decryption failed'))
      .mockResolvedValue(0);
    const onFailure = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = createAuthenticationMailRuntime(
      { runOnce },
      { claim: vi.fn(), settle: vi.fn(), close },
      100,
      onFailure,
    );
    try {
      runtime.start();
      runtime.checkReadiness();
      await vi.advanceTimersByTimeAsync(100);
      expect(onFailure).toHaveBeenCalledOnce();
      expect(() => {
        runtime.checkReadiness();
      }).toThrow('Authentication mail delivery is unavailable');
      await vi.advanceTimersByTimeAsync(100);
      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(() => {
        runtime.checkReadiness();
      }).not.toThrow();
    } finally {
      await runtime.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });
});
