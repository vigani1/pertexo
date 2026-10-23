import { expect, it, vi } from 'vitest';
import {
  QueueJobTimeoutError,
  createQueueConsumer,
} from '../../src/consumer.js';
import type { QueueJobHandler } from '../../src/consumer.js';
import type { QueueConsumerObserver } from '../../src/consumer.js';

import { QUEUE_NAME } from '../../src/jobs/names.js';
import { mocks, validJob } from './fixture.js';

export function registerIsolatesObserverAdmissionFailuresWithoutUnpaired(): void {
  it('isolates observer admission failures without an unpaired finish', async () => {
    const handlerError = new Error('business handler failed');
    const observer = {
      handlerFinished: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
      handlerStarted: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
    } satisfies QueueConsumerObserver;
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: () => Promise.reject(handlerError),
      observer,
    });

    await expect(mocks.workerInstances[0]?.processor(validJob)).rejects.toBe(
      handlerError,
    );
    expect(observer.handlerStarted).toHaveBeenCalledOnce();
    expect(observer.handlerFinished).not.toHaveBeenCalled();
  });

  it('enforces the queue timeout and aborts the handler signal', async () => {
    vi.useFakeTimers();
    try {
      let deliveredSignal: AbortSignal | undefined;
      const observer = {
        handlerFinished: vi.fn(),
        handlerStarted: vi.fn(),
      } satisfies QueueConsumerObserver;
      createQueueConsumer({
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl: 'redis://localhost:6379/0',
        handler: (_job, context) => {
          deliveredSignal = context.signal;
          return new Promise<void>(() => undefined);
        },
        observer,
        timeoutMs: 25,
      });

      const processing = mocks.workerInstances[0]?.processor(validJob);
      const rejection =
        expect(processing).rejects.toBeInstanceOf(QueueJobTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(deliveredSignal?.aborted).toBe(true);
      expect(observer.handlerStarted).toHaveBeenCalledOnce();
      expect(observer.handlerFinished).toHaveBeenCalledWith(
        expect.objectContaining({
          failureClass: 'timeout',
          outcome: 'failed',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes late handler settlement once and admits the following delivery', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (() => void) | undefined;
      let handlerCalls = 0;
      const observer = {
        handlerFinished: vi.fn(),
        handlerStarted: vi.fn(),
      } satisfies QueueConsumerObserver;
      createQueueConsumer({
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl: 'redis://localhost:6379/0',
        handler: () => {
          handlerCalls += 1;
          return handlerCalls === 1
            ? new Promise<void>((resolve) => {
                releaseFirst = resolve;
              })
            : Promise.resolve();
        },
        observer,
        timeoutMs: 25,
      });
      const processor = mocks.workerInstances[0]?.processor;
      const first = processor?.(validJob);
      const firstRejection =
        expect(first).rejects.toBeInstanceOf(QueueJobTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await firstRejection;
      expect(observer.handlerFinished).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await Promise.resolve();
      expect(observer.handlerFinished).toHaveBeenCalledTimes(1);

      await expect(processor?.(validJob)).resolves.toBeUndefined();
      expect(handlerCalls).toBe(2);
      expect(observer.handlerFinished).toHaveBeenCalledTimes(2);
      expect(observer.handlerFinished).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          outcome: 'failed',
          failureClass: 'timeout',
        }),
      );
      expect(observer.handlerFinished).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ outcome: 'completed' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates BullMQ cancellation to the typed handler signal', async () => {
    let deliveredSignal: AbortSignal | undefined;
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
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
    });
    const controller = new AbortController();
    const processing = mocks.workerInstances[0]?.processor(
      validJob,
      undefined,
      controller.signal,
    );

    // Allow admission before cancellation so this covers in-flight signal
    // propagation rather than the separate pre-admission gate.
    await Promise.resolve();

    controller.abort(new Error('cancelled by BullMQ'));

    await expect(processing).rejects.toThrow('cancelled by BullMQ');
    expect(deliveredSignal?.aborted).toBe(true);
  });

  it('does not invoke business code when cancellation wins before admission', async () => {
    const handler = vi.fn<QueueJobHandler>(() => Promise.resolve());
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler,
    });
    const controller = new AbortController();
    const processing = mocks.workerInstances[0]?.processor(
      validJob,
      undefined,
      controller.signal,
    );

    controller.abort(new Error('cancelled before admission'));

    await expect(processing).rejects.toThrow('cancelled before admission');
    expect(handler).not.toHaveBeenCalled();
  });

  it('normalizes a primitive signal that is aborted before processor admission', async () => {
    const handler = vi.fn<QueueJobHandler>(() => Promise.resolve());
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler,
    });
    const controller = new AbortController();
    controller.abort('transport-stopped');

    await expect(
      mocks.workerInstances[0]?.processor(
        validJob,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({
      message: 'Queue handler was aborted',
      cause: 'transport-stopped',
    });
    expect(handler).not.toHaveBeenCalled();
  });
}
