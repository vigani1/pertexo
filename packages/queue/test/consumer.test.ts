import {
  resetPackagesQueueTestConsumerTestTsBullMQQueueConsumerFixture,
  mocks,
  IDS,
  validJob,
  TRACEPARENT,
} from './consumer/fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidQueueDeliveryError,
  createQueueConsumer,
  QueueJobTimeoutError,
  QueueConsumerDrainError,
  unrecoverableQueueError,
  type QueueJobHandler,
  type QueueConsumerObserver,
  type QueueHandlerObservation,
  type QueueTraceRunner,
} from '../src/consumer.js';
import { JOB_NAME, QUEUE_NAME } from '../src/jobs/names.js';
import { jobIdForOutboxEvent } from '../src/producer.js';

describe('BullMQ queue consumer', () => {
  beforeEach(resetPackagesQueueTestConsumerTestTsBullMQQueueConsumerFixture);
  it('maps queue defaults to BullMQ worker and dedicated blocking Redis options', () => {
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });

    expect(mocks.Redis).toHaveBeenCalledWith(
      'redis://localhost:6379/0',
      expect.objectContaining({
        maxRetriesPerRequest: null,
      }),
    );
    expect(mocks.workerInstances).toHaveLength(1);
    expect(mocks.workerInstances[0]?.options).toEqual(
      expect.objectContaining({
        concurrency: 16,
        lockDuration: 30_000,
        lockRenewTime: 15_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
      }),
    );
  });

  it('validates delivery before invoking the typed handler', async () => {
    const handler = vi.fn<QueueJobHandler>(() => Promise.resolve());
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler,
    });
    const processor = mocks.workerInstances[0]?.processor;

    await expect(processor?.({ ...validJob, data: {} })).rejects.toBeInstanceOf(
      InvalidQueueDeliveryError,
    );
    await expect(
      processor?.({ ...validJob, id: 'outbox-wrong' }),
    ).rejects.toBeInstanceOf(InvalidQueueDeliveryError);
    await expect(processor?.({ ...validJob, id: '' })).rejects.toThrow(
      'Queue delivery has no job ID',
    );
    await expect(
      processor?.({
        ...validJob,
        name: JOB_NAME.executeNodeAttempt,
        data: {
          ...validJob.data,
          nodeRunId: IDS.nodeRunId,
          attemptId: IDS.attemptId,
        },
      }),
    ).rejects.toBeInstanceOf(InvalidQueueDeliveryError);
    expect(handler).not.toHaveBeenCalled();

    await processor?.(validJob);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: JOB_NAME.advanceWorkflowRun,
        data: validJob.data,
        transport: {
          attemptsMade: 1,
          jobId: validJob.id,
        },
      }),
    );
    expect(handler.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts the job ID the producer derives for the outbox event', async () => {
    const handler = vi.fn<QueueJobHandler>(() => Promise.resolve());
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler,
    });
    const processor = mocks.workerInstances[0]?.processor;
    const jobId = jobIdForOutboxEvent(validJob.data.outboxEventId);

    await processor?.({ ...validJob, id: jobId });
    expect(handler.mock.calls[0]?.[0].transport.jobId).toBe(jobId);
  });

  it('activates the validated traceparent around the handler', async () => {
    let activeTraceparent: string | undefined;
    let traceRuns = 0;
    const traceRunner = {
      async run<T>(
        traceparent: string | undefined,
        observation: QueueHandlerObservation,
        operation: () => Promise<T>,
      ): Promise<T> {
        traceRuns += 1;
        expect(observation).toEqual({
          jobName: JOB_NAME.advanceWorkflowRun,
          queueName: QUEUE_NAME.workflowCoordinator,
        });
        activeTraceparent = traceparent;
        try {
          return await operation();
        } finally {
          activeTraceparent = undefined;
        }
      },
    } satisfies QueueTraceRunner;
    const handler = vi.fn(() => {
      expect(activeTraceparent).toBe(TRACEPARENT);
      return Promise.resolve();
    });
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler,
      traceRunner,
    });

    await mocks.workerInstances[0]?.processor({
      ...validJob,
      data: { ...validJob.data, traceparent: TRACEPARENT },
    });

    expect(traceRuns).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports fixed-cardinality stalled and graceful lifecycle events', async () => {
    const observer = {
      consumerLifecycle: vi.fn(),
      handlerFinished: vi.fn(),
      handlerStarted: vi.fn(),
      jobStalled: vi.fn(),
    } satisfies QueueConsumerObserver;
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: () => Promise.resolve(),
      observer,
    });

    mocks.workerListeners.get('ready')?.[0]?.();
    mocks.workerListeners.get('stalled')?.[0]?.(validJob.id);
    await consumer.close();

    expect(observer.consumerLifecycle).toHaveBeenCalledWith({
      event: 'ready',
      queueName: QUEUE_NAME.workflowCoordinator,
    });
    expect(observer.jobStalled).toHaveBeenCalledWith({
      queueName: QUEUE_NAME.workflowCoordinator,
    });
    expect(observer.consumerLifecycle).toHaveBeenCalledWith({
      event: 'drain_graceful',
      queueName: QUEUE_NAME.workflowCoordinator,
    });
    expect(JSON.stringify(observer.jobStalled.mock.calls)).not.toContain(
      validJob.id,
    );
  });

  it('reports a paired bounded lifecycle without exposing delivery IDs', async () => {
    const observer = {
      handlerFinished: vi.fn(),
      handlerStarted: vi.fn(),
    } satisfies QueueConsumerObserver;
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: () => Promise.resolve(),
      observer,
    });

    await mocks.workerInstances[0]?.processor(validJob);

    expect(observer.handlerStarted).toHaveBeenCalledOnce();
    expect(observer.handlerStarted).toHaveBeenCalledWith({
      jobName: JOB_NAME.advanceWorkflowRun,
      queueName: QUEUE_NAME.workflowCoordinator,
    });
    expect(observer.handlerFinished).toHaveBeenCalledOnce();
    expect(observer.handlerFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: JOB_NAME.advanceWorkflowRun,
        outcome: 'completed',
        queueName: QUEUE_NAME.workflowCoordinator,
      }),
    );
    const serialized = JSON.stringify(observer.handlerFinished.mock.calls);
    expect(serialized).not.toContain(IDS.workspaceId);
    expect(serialized).not.toContain(IDS.runId);
    expect(serialized).not.toContain(IDS.outboxEventId);
  });

  it('classifies handler failures for the bounded observer', async () => {
    const handlerError = new Error('business handler failed');
    const observer = {
      handlerFinished: vi.fn(),
      handlerStarted: vi.fn(),
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
    expect(observer.handlerFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: 'handler',
        outcome: 'failed',
      }),
    );
  });

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

  it('disconnects BullMQ blocking and owned Redis connections when close times out', async () => {
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      drainTimeoutMs: 2,
      handler: vi.fn(() => Promise.resolve()),
    });
    mocks.workerInstances[0]?.close.mockReturnValue(
      new Promise<void>(() => undefined),
    );

    await expect(consumer.close()).resolves.toEqual({
      abortedJobs: 0,
      forced: true,
    });
    expect(mocks.workerInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.redisClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to disconnect when Redis quit rejects during graceful close', async () => {
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: vi.fn(() => Promise.resolve()),
    });
    mocks.redisClient.quit.mockRejectedValueOnce(new Error('quit failed'));

    await expect(consumer.close()).resolves.toEqual({
      abortedJobs: 0,
      forced: true,
    });
    expect(mocks.redisClient.disconnect).toHaveBeenCalledOnce();
  });

  it('exposes an explicit unrecoverable transport policy seam', () => {
    expect(unrecoverableQueueError('do not redeliver')).toBeInstanceOf(
      mocks.UnrecoverableError,
    );
  });
});
