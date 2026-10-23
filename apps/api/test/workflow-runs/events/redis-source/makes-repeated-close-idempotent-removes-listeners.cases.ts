import { expect, it } from 'vitest';

import {
  WORKSPACE_ID,
  RUN_ID,
  FakeRedis,
  expectNoListeners,
  sourceWithFake,
} from './fixture.js';

export function registerMakesRepeatedCloseIdempotentRemovesListeners(): void {
  it('makes repeated close idempotent, removes listeners, and completes iterators', async () => {
    const fake = new FakeRedis();
    const subscription = await sourceWithFake(fake).subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    const iterator = subscription[Symbol.asyncIterator]();

    await Promise.all([subscription.close(), subscription.close()]);

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(fake.disconnectCalls).toBe(1);
    expectNoListeners(fake);
  });

  it('disconnects and completes the iterator when the request is aborted', async () => {
    const fake = new FakeRedis();
    const controller = new AbortController();
    const subscription = await sourceWithFake(fake).subscribe({
      runId: RUN_ID,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    const pending = subscription[Symbol.asyncIterator]().next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(fake.disconnected).toBe(true);
  });
}
