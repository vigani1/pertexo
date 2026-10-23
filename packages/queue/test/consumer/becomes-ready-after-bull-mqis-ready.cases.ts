import { expect, it, vi } from 'vitest';
import {
  QueueConsumerDrainError,
  createQueueConsumer,
} from '../../src/consumer.js';
import type { QueueJobHandler } from '../../src/consumer.js';
import type { QueueConsumerObserver } from '../../src/consumer.js';

import { QUEUE_NAME } from '../../src/jobs/names.js';
import { mocks, validJob } from './fixture.js';

export function registerBecomesReadyAfterBullMQIsReady(): void {
  it('becomes ready only after BullMQ is ready and closes gracefully', async () => {
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });

    expect(consumer.isReady()).toBe(false);
    await consumer.waitUntilReady();
    expect(consumer.isReady()).toBe(true);

    for (const listener of mocks.workerListeners.get('error') ?? []) {
      listener(new Error('redis unavailable'));
    }
    expect(consumer.isReady()).toBe(false);
    for (const listener of mocks.workerListeners.get('ready') ?? []) {
      listener();
    }
    expect(consumer.isReady()).toBe(true);

    const result = await consumer.close();
    expect(result).toEqual({ abortedJobs: 0, forced: false });
    expect(consumer.isReady()).toBe(false);
    expect(mocks.workerInstances[0]?.pause).toHaveBeenCalledWith(true);
    expect(mocks.workerInstances[0]?.close).toHaveBeenCalledWith(false);
    expect(mocks.redisClient.quit).toHaveBeenCalledTimes(1);
  });

  it('rejects readiness after close and when BullMQ is paused after startup', async () => {
    const closed = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });
    await closed.close();
    await expect(closed.waitUntilReady()).rejects.toThrow(/not ready/i);

    const paused = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });
    const pausedWorker = mocks.workerInstances.at(-1);
    if (pausedWorker === undefined) throw new Error('Expected worker');
    pausedWorker.paused = true;
    await expect(paused.waitUntilReady()).rejects.toThrow(/not ready/i);
  });

  it('bounds readiness and lets close win a pending readiness attempt', async () => {
    vi.useFakeTimers();
    try {
      const timed = createQueueConsumer({
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl: 'redis://localhost:6379/0',
        handler: vi.fn(() => Promise.resolve()),
      });
      const timedWorker = mocks.workerInstances.at(-1);
      timedWorker?.waitUntilReady.mockReturnValue(
        new Promise<void>(() => undefined),
      );
      const timeout = expect(timed.waitUntilReady(25)).rejects.toThrow(
        /not ready/i,
      );
      await vi.advanceTimersByTimeAsync(25);
      await timeout;

      let releaseReady: (() => void) | undefined;
      const closing = createQueueConsumer({
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl: 'redis://localhost:6379/0',
        handler: vi.fn(() => Promise.resolve()),
      });
      const closingWorker = mocks.workerInstances.at(-1);
      closingWorker?.waitUntilReady.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseReady = resolve;
        }),
      );
      const waiting = closing.waitUntilReady(100);
      const rejection = expect(waiting).rejects.toThrow(/not ready/i);
      await closing.close();
      releaseReady?.();
      await rejection;
      expect(closing.isReady()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds drain, aborts active handlers, and forces close', async () => {
    vi.useFakeTimers();
    try {
      let deliveredSignal: AbortSignal | undefined;
      const observer = {
        handlerFinished: vi.fn(),
        handlerStarted: vi.fn(),
      } satisfies QueueConsumerObserver;
      const consumer = createQueueConsumer({
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl: 'redis://localhost:6379/0',
        drainTimeoutMs: 25,
        handler: (_job, context) => {
          deliveredSignal = context.signal;
          return new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => {
                reject(
                  context.signal.reason instanceof Error
                    ? context.signal.reason
                    : new Error('Queue handler aborted'),
                );
              },
              { once: true },
            );
          });
        },
        observer,
      });
      const processing = mocks.workerInstances[0]?.processor(validJob);
      const processingRejection = expect(processing).rejects.toBeInstanceOf(
        QueueConsumerDrainError,
      );
      const closing = consumer.close();
      await vi.advanceTimersByTimeAsync(25);
      const result = await closing;

      await processingRejection;
      expect(result).toEqual({ abortedJobs: 1, forced: true });
      expect(deliveredSignal?.aborted).toBe(true);
      expect(mocks.workerInstances[0]?.cancelAllJobs).toHaveBeenCalledTimes(1);
      expect(mocks.workerInstances[0]?.close).toHaveBeenCalledWith(true);
      expect(observer.handlerFinished).toHaveBeenCalledWith(
        expect.objectContaining({
          failureClass: 'drain',
          outcome: 'failed',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit a delivery after drain starts', async () => {
    const handler = vi.fn<QueueJobHandler>(() => Promise.resolve());
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler,
    });
    const processor = mocks.workerInstances[0]?.processor;

    await consumer.close();

    await expect(processor?.(validJob)).rejects.toBeInstanceOf(
      QueueConsumerDrainError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('still disconnects and reports a forced close when pause fails', async () => {
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });
    mocks.workerInstances[0]?.pause.mockRejectedValue(
      new Error('redis unavailable'),
    );

    await expect(consumer.close()).resolves.toEqual({
      abortedJobs: 0,
      forced: true,
    });
    expect(mocks.workerInstances[0]?.close).toHaveBeenCalledWith(true);
  });

  it('disconnects BullMQ blocking and owned Redis connections when close fails', async () => {
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });
    mocks.workerInstances[0]?.close.mockRejectedValue(
      new Error('blocking connection did not close'),
    );

    await expect(consumer.close()).resolves.toEqual({
      abortedJobs: 0,
      forced: true,
    });
    expect(mocks.workerInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.redisClient.disconnect).toHaveBeenCalledTimes(1);
  });
}
