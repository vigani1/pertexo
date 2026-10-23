import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

import { writeSseFrames } from '../../../../src/workflow-runs/events/sse-transport.js';

import { StreamCleanupIncompleteError } from '../../../../src/workflow-runs/events/stream-cleanup.js';

import { frame } from './fixture.js';

export function registerDoesNotReadAheadTransportIs(): void {
  it('does not read ahead while the transport is backpressured', async () => {
    let produced = 0;
    const frames = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (let id = 1; id <= 1_000; id += 1) {
          produced += 1;
          yield frame(id);
        }
      },
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn<(chunk: string) => boolean>>;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    const writing = writeSseFrames(frames, destination, {
      controller: new AbortController(),
      visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
      fallbackPath: 'initial_backfill',
    });

    await vi.waitFor(() => {
      expect(destination.write).toHaveBeenCalledOnce();
    });
    expect(produced).toBe(1);
    destination.emit('drain');
    await writing;

    expect(produced).toBe(1_000);
    expect(destination.write).toHaveBeenCalledTimes(1_000);
    expect(
      destination.write.mock.calls.map(([chunk]) =>
        Number(/^id: (\d+)/u.exec(chunk)?.[1]),
      ),
    ).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('stops a blocked producer on disconnect and leaves replay to the durable cursor', async () => {
    let returned = false;
    let produced = 0;
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          produced += 1;
          return Promise.resolve({
            done: false as const,
            value: frame(produced),
          });
        },
        return: () => {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: () => void;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValue(false);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    const controller = new AbortController();
    const writing = writeSseFrames(frames, destination, {
      controller: controller,
      visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
      fallbackPath: 'reconnect_backfill',
    });
    await vi.waitFor(() => {
      expect(destination.listenerCount('drain')).toBe(1);
    });

    controller.abort();
    await writing;

    expect(produced).toBe(1);
    expect(returned).toBe(true);
    expect(destination.listenerCount('drain')).toBe(0);
    expect(destination.listenerCount('close')).toBe(0);
    expect(destination.listenerCount('error')).toBe(0);
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('preserves producer and cleanup failures while still ending the destination', async () => {
    const readError = new Error('producer read failed');
    const returnError = new Error('producer cleanup failed');
    const endError = new Error('destination end failed');
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject<IteratorResult<ReturnType<typeof frame>>>(readError),
        return: () =>
          Promise.reject<IteratorResult<ReturnType<typeof frame>>>(returnError),
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi.fn().mockReturnValue(true);
    destination.end = vi.fn(() => {
      throw endError;
    });
    destination.destroy = vi.fn();
    destination.destroyed = false;

    const failure = await writeSseFrames(frames, destination, {
      controller: new AbortController(),
      visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
      fallbackPath: 'live_wakeup',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      readError,
      returnError,
      endError,
    ]);
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('ends transport within one budget while retaining noncooperative producer cleanup', async () => {
    vi.useFakeTimers();
    const readError = new Error('producer read failed');
    const heldReturn = Promise.withResolvers<IteratorResult<never>>();
    const returnIterator = vi.fn(() => heldReturn.promise);
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject<IteratorResult<never>>(readError),
        return: returnIterator,
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi.fn().mockReturnValue(true);
    destination.end = vi.fn();
    destination.destroy = vi.fn();
    destination.destroyed = false;
    const controller = new AbortController();
    let failure: StreamCleanupIncompleteError | undefined;
    try {
      const writing = writeSseFrames(frames, destination, {
        controller: controller,
        visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
        fallbackPath: 'live_wakeup',
        cleanupBudgetMs: 25,
      });
      const observed = writing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      const result = await observed;
      expect(result).toBeInstanceOf(StreamCleanupIncompleteError);
      failure = result as StreamCleanupIncompleteError;
      expect(failure.errors[0]).toBe(readError);
      expect(failure.errors[1]).toMatchObject({
        message: 'Workflow event stream cleanup exceeded 25ms',
      });
      expect(controller.signal.aborted).toBe(true);
      expect(returnIterator).toHaveBeenCalledOnce();
      expect(destination.end).toHaveBeenCalledOnce();

      heldReturn.resolve({ done: true, value: undefined });
      await failure.completion;
      await expect(failure.outcome).resolves.toBeUndefined();
    } finally {
      heldReturn.resolve({ done: true, value: undefined });
      await failure?.completion;
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
}
