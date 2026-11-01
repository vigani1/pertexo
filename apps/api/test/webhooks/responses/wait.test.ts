import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookResponseWaiter } from '../../../src/webhooks/responses/wait.js';
import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from '@pertexo/core/triggers';
// Node promises timers need their own controlled-clock seam. Wake one ms early
// to exercise the real boundary without relying on CI scheduling luck.
vi.mock('node:timers/promises', () => ({
  setTimeout: (
    millis: number,
    value: unknown,
    options: { signal: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        reject(new Error('Aborted'));
      };
      const timer = setTimeout(
        () => {
          options.signal.removeEventListener('abort', abort);
          resolve(value);
        },
        Math.max(1, millis - 1),
      );
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }),
}));
beforeEach(() => {
  vi.useFakeTimers();
});
const scope = {
  workspaceId: 'workspace',
  runId: 'run',
  seconds: 1,
  signal: new AbortController().signal,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('bounded webhook waits', () => {
  it('reads committed state and returns without holding a sleeping waiter', async () => {
    const read = vi
      .fn<(input: WebhookResponseScope) => Promise<WebhookResponseSnapshot>>()
      .mockResolvedValue({ state: 'finished' });
    const waiter = createWebhookResponseWaiter(read);
    expect(await waiter.wait(scope)).toEqual({ state: 'finished' });
    expect(read).toHaveBeenCalledTimes(1);
    waiter.close();
  });
  it('bounds 32 waits to 128 indexed reads/second and returns overflow immediately', async () => {
    const read = vi
      .fn<(input: WebhookResponseScope) => Promise<WebhookResponseSnapshot>>()
      .mockResolvedValue({ state: 'pending' });
    const waiter = createWebhookResponseWaiter(read);
    const waiting = Array.from({ length: 32 }, () => waiter.wait(scope));
    expect(await waiter.wait(scope)).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.all(waiting)).toEqual(
      Array.from({ length: 32 }, () => null),
    );
    expect(read).toHaveBeenCalledTimes(128);
    expect(vi.getTimerCount()).toBe(0);
    read.mockResolvedValue({ state: 'finished' });
    expect(await waiter.wait(scope)).toEqual({ state: 'finished' });
    waiter.close();
  });
  it('discards a late read even when the deadline callback has not run yet', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const read = vi.fn(() => {
      now = 1001;
      return Promise.resolve({ state: 'finished' as const });
    });
    const waiter = createWebhookResponseWaiter(read);
    expect(await waiter.wait(scope)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    waiter.close();
  });
  it('aborts an in-flight read at the deadline, and frees the slot', async () => {
    vi.useFakeTimers();
    let readSignal: AbortSignal | undefined;
    const waiter = createWebhookResponseWaiter(async ({ signal }) => {
      readSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Read aborted', { cause: signal.reason }));
          },
          { once: true },
        );
      });
    });
    const wait = waiter.wait(scope);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await wait).toBeNull();
    expect(readSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    waiter.close();
  });
  it.each(['disconnect', 'shutdown'] as const)(
    'releases timers and database reads on %s',
    async (kind) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const read = vi
        .fn<(input: WebhookResponseScope) => Promise<WebhookResponseSnapshot>>()
        .mockResolvedValue({ state: 'pending' });
      const waiter = createWebhookResponseWaiter(read);
      const wait = waiter.wait({ ...scope, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      if (kind === 'disconnect') controller.abort();
      else waiter.close();
      expect(await wait).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(read).toHaveBeenCalledTimes(1);
      waiter.close();
    },
  );
  it('propagates infrastructure failure for the accepted-response adapter to fall back safely', async () => {
    const waiter = createWebhookResponseWaiter(() =>
      Promise.reject(new Error('private database error')),
    );
    await expect(waiter.wait(scope)).rejects.toThrow('private database error');
    waiter.close();
  });
});
