import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookResponseWaiter } from '../../../src/webhooks/responses/wait.js';
import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from '@pertexo/database/triggers';
const scope = {
  workspaceId: 'workspace',
  runId: 'run',
  seconds: 1,
  signal: new AbortController().signal,
};
afterEach(() => {
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
    expect(await Promise.all(waiting)).toEqual(
      Array.from({ length: 32 }, () => null),
    );
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(32);
    expect(read.mock.calls.length).toBeLessThanOrEqual(128);
    read.mockResolvedValue({ state: 'finished' });
    expect(await waiter.wait(scope)).toEqual({ state: 'finished' });
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
