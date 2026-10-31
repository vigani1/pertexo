import { expect, it, vi } from 'vitest';
import {
  BullMqQueueProducer,
  createQueueProducer,
  jobIdForOutboxEvent,
} from '../../src/producer.js';
import { JOB_NAME, QUEUE_NAME } from '../../src/jobs/names.js';
import type { RedisTelemetryObserver } from '../../src/redis/telemetry-contracts.js';
import { mocks, IDS, redisClient } from './fixture.js';

export function registerDerivesStableNonnumericColonFreeJob(): void {
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
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      },
    });

    expect(enqueued).toEqual({
      jobId: `outbox-${IDS.outboxEventId}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'published',
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
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        outboxEventId: IDS.outboxEventId,
      }),
      expect.objectContaining({
        attempts: 8,
        backoff: { type: 'exponential', delay: 1_000 },
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

  it('reports bounded Redis operations and isolates telemetry failures', async () => {
    const redisTelemetry = {
      connectionEvent: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
      operationFinished: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
    } satisfies RedisTelemetryObserver;
    const producer = createQueueProducer({
      redisTelemetry,
      redisUrl: 'redis://localhost:6379/0',
    });

    redisClient().emit('ready');
    await expect(
      producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ jobName: JOB_NAME.advanceWorkflowRun }),
    );

    expect(redisTelemetry.connectionEvent).toHaveBeenCalledWith({
      clientRole: 'queue_producer',
      event: 'ready',
    });
    expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRole: 'queue_producer',
        operation: 'publish',
        outcome: 'success',
      }),
    );
    expect(
      JSON.stringify(redisTelemetry.operationFinished.mock.calls),
    ).not.toContain(IDS.runId);
  });

  it('fails fast while Redis is not ready and supports readiness recovery', async () => {
    mocks.redisFactoryState.nextStatus = 'connecting';
    const producer = new BullMqQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });

    expect(producer.isReady()).toBe(false);
    await expect(
      producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
      }),
    ).rejects.toThrow(/not ready/i);

    redisClient().status = 'ready';
    redisClient().emit('ready');
    expect(producer.isReady()).toBe(true);
  });

  it('keeps Redis listener state isolated between producer clients', async () => {
    const first = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    const second = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });

    redisClient(0).emit('error');
    expect(first.isReady()).toBe(false);
    expect(second.isReady()).toBe(true);

    await Promise.all([first.close(), second.close()]);
  });

  it('bounds readiness, rejects observation while unavailable, and lets close win', async () => {
    vi.useFakeTimers();
    try {
      mocks.redisFactoryState.nextStatus = 'connecting';
      const producer = createQueueProducer({
        redisUrl: 'redis://localhost:6379/0',
      });

      await expect(producer.observe()).rejects.toThrow(/not ready/i);
      const timed = expect(producer.waitUntilReady(25)).rejects.toThrow(
        /not ready/i,
      );
      await vi.advanceTimersByTimeAsync(30);
      await timed;

      const waiting = producer.waitUntilReady(100);
      const closed = producer.close();
      const rejection = expect(waiting).rejects.toThrow(/not ready/i);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([closed, rejection]);
      expect(producer.isReady()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['close', 'error'] as const)(
    'rejects queue readiness when Redis emits %s during BullMQ readiness',
    async (event) => {
      const producer = createQueueProducer({
        redisUrl: 'redis://localhost:6379/0',
      });
      let releaseReady: (() => void) | undefined;
      mocks.queueInstances[0]?.waitUntilReady.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseReady = resolve;
        }),
      );
      const waiting = producer.waitUntilReady();
      const rejection = expect(waiting).rejects.toThrow(/not ready/i);

      redisClient().emit(event);
      releaseReady?.();

      await rejection;
      expect(producer.isReady()).toBe(false);
    },
  );
}
