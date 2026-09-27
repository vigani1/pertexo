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

  it('isolates throwing diagnostics while retaining failure and recovery readiness', async () => {
    vi.useFakeTimers();
    const runOnce = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('delivery unavailable'))
      .mockResolvedValue(0);
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = createAuthenticationMailRuntime(
      { runOnce },
      { claim: vi.fn(), settle: vi.fn(), close },
      100,
      () => {
        throw new Error('diagnostic unavailable');
      },
    );
    try {
      runtime.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(() => {
        runtime.checkReadiness();
      }).toThrow('Authentication mail delivery is unavailable');
      await vi.advanceTimersByTimeAsync(100);
      expect(() => {
        runtime.checkReadiness();
      }).not.toThrow();
    } finally {
      await runtime.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('attempts owned cleanup once when shutdown overlaps a rejected delivery and diagnostic', async () => {
    vi.useFakeTimers();
    let rejectDelivery: (reason: Error) => void = () => undefined;
    const delivery = new Promise<number>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = createAuthenticationMailRuntime(
      { runOnce: () => delivery },
      { claim: vi.fn(), settle: vi.fn(), close },
      100,
      () => {
        throw new Error('diagnostic unavailable');
      },
    );
    runtime.start();
    vi.advanceTimersByTime(100);
    const closing = runtime.close();
    const result = expect(closing).resolves.toBeUndefined();
    rejectDelivery(new Error('delivery unavailable'));
    await result;
    expect(runtime.close()).toBe(closing);
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports owned close failure without repeating cleanup', async () => {
    const failure = new Error('store close failed');
    const close = vi.fn().mockRejectedValue(failure);
    const runtime = createAuthenticationMailRuntime(
      { runOnce: () => Promise.resolve(0) },
      { claim: vi.fn(), settle: vi.fn(), close },
      100,
      vi.fn(),
    );
    const closing = runtime.close();
    await expect(closing).rejects.toBe(failure);
    expect(runtime.close()).toBe(closing);
    expect(close).toHaveBeenCalledOnce();
  });

  it('observes synchronous handler failure as a failed delivery cycle', async () => {
    vi.useFakeTimers();
    const close = vi.fn().mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const runtime = createAuthenticationMailRuntime(
      {
        runOnce: () => {
          throw new Error('handler unavailable');
        },
      },
      { claim: vi.fn(), settle: vi.fn(), close },
      100,
      onFailure,
    );
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(() => {
      runtime.checkReadiness();
    }).toThrow('Authentication mail delivery is unavailable');
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
