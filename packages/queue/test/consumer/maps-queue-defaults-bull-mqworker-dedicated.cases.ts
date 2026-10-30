import { expect, it, vi } from 'vitest';
import {
  InvalidQueueDeliveryError,
  createQueueConsumer,
} from '../../src/consumer.js';
import type { QueueJobHandler } from '../../src/consumer.js';
import type { QueueConsumerObserver } from '../../src/consumer.js';
import type {
  QueueHandlerObservation,
  QueueTraceRunner,
} from '../../src/consumer.js';
import { JOB_NAME, QUEUE_NAME } from '../../src/jobs/names.js';
import { jobIdForOutboxEvent } from '../../src/producer.js';
import { mocks, IDS, validJob, TRACEPARENT } from './fixture.js';

export function registerMapsQueueDefaultsBullMQWorkerDedicated(): void {
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
}
