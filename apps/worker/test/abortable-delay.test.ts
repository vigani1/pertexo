import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  waitForAbortableDelay,
  waitForSupervisorDelay,
} from '../src/runtime/abortable-delay.js';

describe('worker abortable delays', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the supervisor abort listener after elapsed completion', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = waitForSupervisorDelay(25, controller.signal);

    await vi.advanceTimersByTimeAsync(25);
    await expect(waiting).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('resolves a supervisor delay and clears its timer when aborted', async () => {
    const controller = new AbortController();
    const waiting = waitForSupervisorDelay(25, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an operational delay with AbortError and clears its timer', async () => {
    const controller = new AbortController();
    const waiting = waitForAbortableDelay(25, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
