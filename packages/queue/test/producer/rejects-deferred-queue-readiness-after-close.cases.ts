import { expect, it, vi } from 'vitest';
import { createQueueProducer } from '../../src/producer.js';
import { JOB_NAME, QUEUE_NAME } from '../../src/jobs/names.js';

import { mocks, IDS, redisClient } from './fixture.js';

export function registerRejectsDeferredQueueReadinessAfterClose(): void {
  it('rejects deferred queue readiness after close fully wins', async () => {
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

    await producer.close();
    releaseReady?.();

    await rejection;
    expect(producer.isReady()).toBe(false);
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
    coordinator?.getJobs.mockResolvedValueOnce([
      { timestamp: Date.now() - 2_000 },
    ]);

    const observations = await producer.observe();

    expect(observations).toContainEqual({
      depth: 3,
      oldestJobAgeSeconds: 2,
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
    expect(coordinator?.getJobs).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('bounds a stalled queue observation', async () => {
    vi.useFakeTimers();
    try {
      const producer = createQueueProducer({
        publishTimeoutMs: 25,
        redisUrl: 'redis://localhost:6379/0',
      });
      mocks.queueInstances[0]?.getJobCountByTypes.mockReturnValue(
        new Promise<number>(() => undefined),
      );
      const observing = expect(producer.observe()).rejects.toThrow(
        /bounded timeout/iu,
      );
      await vi.advanceTimersByTimeAsync(25);
      await observing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a non-Error observation failure into an Error keeping its cause', async () => {
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    // Redis client libraries can reject with a bare reply string.
    const reply = "READONLY You can't write against a read only replica";
    mocks.queueInstances[0]?.getJobCountByTypes.mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject(reply),
    );
    await expect(producer.observe()).rejects.toSatisfy(
      (error) => error instanceof Error && error.cause === reply,
    );
  });

  it('reports an explicit unknown outcome and retains late settlement truth', async () => {
    vi.useFakeTimers();
    try {
      const producer = createQueueProducer({
        publishTimeoutMs: 25,
        redisUrl: 'redis://localhost:6379/0',
      });
      const coordinator = mocks.queueInstances.find(
        (queue) => queue.name === QUEUE_NAME.workflowCoordinator,
      );
      let settle: ((value: unknown) => void) | undefined;
      coordinator?.add.mockReturnValue(
        new Promise<unknown>((resolve) => {
          settle = resolve;
        }),
      );

      const publishing = producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          outboxEventId: IDS.outboxEventId,
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await publishing;

      expect(result).toMatchObject({ outcome: 'outcome_unknown' });
      if (result.outcome !== 'outcome_unknown')
        throw new Error('Expected an unknown publication outcome');
      settle?.({ id: result.jobId });
      await expect(result.settlement).resolves.toBe('published');
    } finally {
      vi.useRealTimers();
    }
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
    expect(redisClient().quit).toHaveBeenCalledTimes(1);
    expect(producer.isReady()).toBe(false);
  });

  it('shares concurrent close settlement and disconnects after a bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      const producer = createQueueProducer({
        closeTimeoutMs: 25,
        redisUrl: 'redis://localhost:6379/0',
      });
      mocks.queueInstances[0]?.close.mockReturnValue(
        new Promise<void>(() => undefined),
      );

      const first = producer.close();
      const second = producer.close();
      const firstRejection = expect(first).rejects.toThrow(/close.*timeout/iu);
      const secondRejection =
        expect(second).rejects.toThrow(/close.*timeout/iu);
      await vi.advanceTimersByTimeAsync(25);

      await Promise.all([firstRejection, secondRejection]);
      for (const queue of mocks.queueInstances) {
        expect(queue.close).toHaveBeenCalledOnce();
        expect(queue.disconnect).toHaveBeenCalledOnce();
      }
      expect(redisClient().quit).toHaveBeenCalledOnce();
      expect(redisClient().disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares an immediate close rejection and attempts cleanup for every owner', async () => {
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    const failure = new Error('queue close failed');
    mocks.queueInstances[0]?.close.mockRejectedValue(failure);

    const first = producer.close();
    const second = producer.close();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    for (const queue of mocks.queueInstances) {
      expect(queue.close).toHaveBeenCalledOnce();
      expect(queue.disconnect).toHaveBeenCalledOnce();
    }
    expect(redisClient().quit).toHaveBeenCalledOnce();
    expect(redisClient().disconnect).toHaveBeenCalledOnce();
    expect(producer.isReady()).toBe(false);
  });

  it('observes rejecting, throwing, and stalled fallback disconnects while preserving close failure', async () => {
    const producer = createQueueProducer({
      redisUrl: 'redis://localhost:6379/0',
    });
    const failure = new Error('authoritative close failure');
    mocks.queueInstances[0]?.close.mockRejectedValue(failure);
    mocks.queueInstances[0]?.disconnect.mockRejectedValue(
      new Error('disconnect rejected'),
    );
    mocks.queueInstances[1]?.disconnect.mockImplementation(() => {
      throw new Error('disconnect threw');
    });
    mocks.queueInstances[2]?.disconnect.mockReturnValue(
      new Promise<void>(() => undefined),
    );
    const rejectingDisconnect = (): unknown =>
      Promise.reject(new Error('redis disconnect rejected'));
    redisClient().disconnect.mockImplementation(rejectingDisconnect);

    const first = producer.close();
    const second = producer.close();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await Promise.resolve();

    for (const queue of mocks.queueInstances)
      expect(queue.disconnect).toHaveBeenCalledOnce();
    expect(redisClient().disconnect).toHaveBeenCalledOnce();
    expect(producer.isReady()).toBe(false);
  });
}
