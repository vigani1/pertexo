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

  it('settles both delay policies immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, 'addEventListener');

    await expect(
      waitForSupervisorDelay(25, controller.signal),
    ).resolves.toBeUndefined();
    await expect(
      waitForAbortableDelay(25, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves elapsed operational work and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = waitForAbortableDelay(25, controller.signal);

    await vi.advanceTimersByTimeAsync(25);

    await expect(waiting).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { policy: 'supervisor', rejects: false },
    { policy: 'operational', rejects: true },
  ] as const)(
    'closes the abort-during-listener-registration race for $policy work',
    async ({ policy, rejects }) => {
      let reads = 0;
      const addEventListener = vi.fn();
      const removeEventListener = vi.fn();
      const signal = {
        get aborted() {
          reads += 1;
          return reads > 1;
        },
        addEventListener,
        removeEventListener,
      } as unknown as AbortSignal;

      const waiting =
        policy === 'supervisor'
          ? waitForSupervisorDelay(25, signal)
          : waitForAbortableDelay(25, signal);

      if (rejects)
        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(waiting).resolves.toBeUndefined();
      expect(addEventListener).toHaveBeenCalledOnce();
      expect(removeEventListener).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
