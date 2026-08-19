import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type Processor = (
    job: { id?: string; name: string; data: unknown; attemptsMade: number },
    token?: string,
    signal?: AbortSignal,
  ) => Promise<void>;

  interface WorkerInstance {
    name: string;
    options: Record<string, unknown>;
    processor: Processor;
    running: boolean;
    paused: boolean;
    waitUntilReady: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    cancelAllJobs: ReturnType<typeof vi.fn>;
    isRunning: () => boolean;
    isPaused: () => boolean;
    on: ReturnType<typeof vi.fn>;
  }

  const workerInstances: WorkerInstance[] = [];
  const workerListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const redisClient = {
    status: 'ready',
    on: vi.fn(() => redisClient),
    quit: vi.fn(() => Promise.resolve('OK')),
    disconnect: vi.fn(),
  };

  class UnrecoverableError extends Error {
    public override readonly name = 'UnrecoverableError';
  }

  const Worker = vi.fn(function WorkerMock(
    name: string,
    processor: Processor,
    options: Record<string, unknown>,
  ) {
    const instance: WorkerInstance = {
      name,
      options,
      processor,
      running: true,
      paused: false,
      waitUntilReady: vi.fn(() => Promise.resolve()),
      pause: vi.fn((doNotWaitActive: boolean) => {
        instance.paused = true;
        return Promise.resolve(doNotWaitActive);
      }),
      close: vi.fn(() => {
        instance.running = false;
        return Promise.resolve();
      }),
      disconnect: vi.fn(() => Promise.resolve()),
      cancelAllJobs: vi.fn(),
      isRunning: () => instance.running,
      isPaused: () => instance.paused,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const listeners = workerListeners.get(event) ?? [];
        listeners.push(listener);
        workerListeners.set(event, listeners);
        return instance;
      }),
    };
    workerInstances.push(instance);
    return instance;
  });

  const Redis = vi.fn(function RedisMock() {
    return redisClient;
  });

  return {
    Redis,
    UnrecoverableError,
    Worker,
    redisClient,
    workerInstances,
    workerListeners,
  };
});

vi.mock('bullmq', () => ({
  UnrecoverableError: mocks.UnrecoverableError,
  Worker: mocks.Worker,
}));
vi.mock('ioredis', () => ({ Redis: mocks.Redis, default: mocks.Redis }));

import {
  InvalidQueueDeliveryError,
  QueueConsumerDrainError,
  QueueJobTimeoutError,
  createQueueConsumer,
  unrecoverableQueueError,
} from '../src/consumer.js';
import type { QueueJobHandler } from '../src/consumer.js';
import { JOB_NAME, QUEUE_NAME } from '../src/names.js';

const IDS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  outboxEventId: '88888888-8888-4888-8888-888888888888',
  nodeRunId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
} as const;

const validJob = {
  id: `outbox-${IDS.outboxEventId}`,
  name: JOB_NAME.advanceWorkflowRun,
  data: {
    schemaVersion: 1,
    workspaceId: IDS.workspaceId,
    runId: IDS.runId,
    outboxEventId: IDS.outboxEventId,
  },
  attemptsMade: 1,
};

describe('BullMQ queue consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerInstances.length = 0;
    mocks.workerListeners.clear();
    mocks.redisClient.status = 'ready';
  });

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

    await expect(
      processor?.({ ...validJob, data: { schemaVersion: 99 } }),
    ).rejects.toBeInstanceOf(InvalidQueueDeliveryError);
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

  it('enforces the queue timeout and aborts the handler signal', async () => {
    let deliveredSignal: AbortSignal | undefined;
    createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      handler: (_job, context) => {
        deliveredSignal = context.signal;
        return new Promise<void>(() => undefined);
      },
      timeoutMs: 2,
    });

    await expect(
      mocks.workerInstances[0]?.processor(validJob),
    ).rejects.toBeInstanceOf(QueueJobTimeoutError);
    expect(deliveredSignal?.aborted).toBe(true);
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

  it('bounds drain, aborts active handlers, and forces close', async () => {
    let deliveredSignal: AbortSignal | undefined;
    const consumer = createQueueConsumer({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
      drainTimeoutMs: 2,
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
    const processing = mocks.workerInstances[0]?.processor(validJob);

    const result = await consumer.close();

    await expect(processing).rejects.toBeInstanceOf(QueueConsumerDrainError);
    expect(result).toEqual({ abortedJobs: 1, forced: true });
    expect(deliveredSignal?.aborted).toBe(true);
    expect(mocks.workerInstances[0]?.cancelAllJobs).toHaveBeenCalledTimes(1);
    expect(mocks.workerInstances[0]?.close).toHaveBeenCalledWith(true);
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

  it('exposes an explicit unrecoverable transport policy seam', () => {
    expect(unrecoverableQueueError('do not redeliver')).toBeInstanceOf(
      mocks.UnrecoverableError,
    );
  });
});
