import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface QueueInstance {
    name: string;
    options: unknown;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getJobCountByTypes: ReturnType<typeof vi.fn>;
    getJobs: ReturnType<typeof vi.fn>;
    waitUntilReady: ReturnType<typeof vi.fn>;
  }

  interface RedisClient {
    status: string;
    on: (event: string, listener: () => void) => RedisClient;
    emit: (event: string) => boolean;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }

  const queueInstances: QueueInstance[] = [];
  const redisListeners = new Map<string, (() => void)[]>();
  const redisClient: RedisClient = {
    status: 'ready',
    on: vi.fn((event: string, listener: () => void) => {
      const listeners = redisListeners.get(event) ?? [];
      listeners.push(listener);
      redisListeners.set(event, listeners);
      return redisClient;
    }),
    emit: vi.fn((event: string) => {
      for (const listener of redisListeners.get(event) ?? []) {
        listener();
      }
      return true;
    }),
    quit: vi.fn(() => Promise.resolve('OK')),
    disconnect: vi.fn(),
  };

  const Queue = vi.fn(function QueueMock(name: string, options: unknown) {
    const queue: QueueInstance = {
      name,
      options,
      add: vi.fn(() => Promise.resolve({ id: 'mock-job-id' })),
      close: vi.fn(() => Promise.resolve()),
      getJobCountByTypes: vi.fn(() => Promise.resolve(0)),
      getJobs: vi.fn(() => Promise.resolve([])),
      waitUntilReady: vi.fn(() => Promise.resolve()),
    };
    queueInstances.push(queue);
    return queue;
  });
  const Redis = vi.fn(function RedisMock() {
    return redisClient;
  });

  return { Queue, Redis, queueInstances, redisClient };
});

vi.mock('bullmq', () => ({ Queue: mocks.Queue }));
vi.mock('ioredis', () => ({ Redis: mocks.Redis, default: mocks.Redis }));

import {
  BullMqQueueProducer,
  createQueueProducer,
  jobIdForOutboxEvent,
} from '../src/producer.js';
import { JOB_NAME, QUEUE_NAME } from '../src/names.js';

const IDS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  outboxEventId: '88888888-8888-4888-8888-888888888888',
} as const;

describe('BullMQ queue producer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueInstances.length = 0;
    mocks.redisClient.status = 'ready';
  });

  it('derives a stable nonnumeric, colon-free job ID from the outbox event', () => {
    const jobId = jobIdForOutboxEvent(IDS.outboxEventId);

    expect(jobId).toBe(`outbox-${IDS.outboxEventId}`);
    expect(jobId).not.toMatch(/^\d+$/);
    expect(jobId).not.toContain(':');
  });

  it('fails before opening a producer for invalid Redis configuration', () => {
    expect(() =>
      createQueueProducer({ redisUrl: 'postgres://not-redis' }),
    ).toThrow(/redis url/i);
    expect(mocks.Redis).not.toHaveBeenCalled();
  });

  it('routes validated jobs and applies centralized transport defaults', async () => {
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    expect(mocks.Redis).toHaveBeenCalledWith(
      'redis://localhost:6379/0',
      expect.objectContaining({
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      }),
    );
    const enqueued = await producer.publish({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    });

    expect(enqueued).toEqual({
      jobId: `outbox-${IDS.outboxEventId}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      queueName: QUEUE_NAME.workflowCoordinator,
    });
    expect(mocks.queueInstances).toHaveLength(4);

    const coordinator = mocks.queueInstances.find(
      (queue) => queue.name === QUEUE_NAME.workflowCoordinator,
    );
    expect(coordinator).toBeDefined();
    expect(coordinator?.add).toHaveBeenCalledWith(
      JOB_NAME.advanceWorkflowRun,
      expect.objectContaining({
        schemaVersion: 1,
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'fixed', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 2_592_000, count: 10_000 },
        jobId: `outbox-${IDS.outboxEventId}`,
      }),
    );

    await producer.waitUntilReady();
    for (const queue of mocks.queueInstances) {
      expect(queue.waitUntilReady).toHaveBeenCalledTimes(1);
    }
  });

  it('fails fast while Redis is not ready and supports readiness recovery', async () => {
    mocks.redisClient.status = 'connecting';
    const producer = new BullMqQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });

    expect(producer.isReady()).toBe(false);
    await expect(
      producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
      }),
    ).rejects.toThrow(/not ready/i);

    mocks.redisClient.status = 'ready';
    mocks.redisClient.emit('ready');
    expect(producer.isReady()).toBe(true);
  });

  it('observes bounded queue depth and oldest-job age without reading payloads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:10.000Z'));
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    const coordinator = mocks.queueInstances.find(
      (queue) => queue.name === QUEUE_NAME.workflowCoordinator,
    );
    coordinator?.getJobCountByTypes.mockResolvedValue(3);
    coordinator?.getJobs
      .mockResolvedValueOnce([{ timestamp: Date.now() - 2_000 }])
      .mockResolvedValueOnce([{ timestamp: Date.now() - 7_500 }]);

    const observations = await producer.observe();

    expect(observations).toContainEqual({
      depth: 3,
      oldestJobAgeSeconds: 7.5,
      queueName: QUEUE_NAME.workflowCoordinator,
    });
    expect(coordinator?.getJobCountByTypes).toHaveBeenCalledWith(
      'waiting',
      'delayed',
    );
    expect(coordinator?.getJobs).toHaveBeenNthCalledWith(
      1,
      'waiting',
      0,
      0,
      true,
    );
    expect(coordinator?.getJobs).toHaveBeenNthCalledWith(
      2,
      'delayed',
      0,
      0,
      true,
    );
    vi.useRealTimers();
  });

  it('bounds a Redis publish so the outbox lease can be released', async () => {
    const producer = createQueueProducer({
      publishTimeoutMs: 1,
      redisUrl: 'redis://localhost:6379/0',
    });
    const coordinator = mocks.queueInstances.find(
      (queue) => queue.name === QUEUE_NAME.workflowCoordinator,
    );
    coordinator?.add.mockReturnValue(new Promise<unknown>(() => undefined));

    await expect(
      producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
      }),
    ).rejects.toThrow(/bounded timeout/i);
  });

  it('surfaces an immediate Redis command failure to the outbox caller', async () => {
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    const coordinator = mocks.queueInstances.find(
      (queue) => queue.name === QUEUE_NAME.workflowCoordinator,
    );
    coordinator?.add.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
      }),
    ).rejects.toThrow('redis unavailable');
  });

  it('closes every queue and the Redis connection idempotently', async () => {
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });

    await producer.close();
    await producer.close();

    expect(mocks.queueInstances).toHaveLength(4);
    for (const queue of mocks.queueInstances) {
      expect(queue.close).toHaveBeenCalledTimes(1);
    }
    expect(mocks.redisClient.quit).toHaveBeenCalledTimes(1);
    expect(producer.isReady()).toBe(false);
  });
});
