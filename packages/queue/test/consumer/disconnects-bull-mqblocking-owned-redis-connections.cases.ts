import { expect, it, vi } from 'vitest';
import {
  createQueueConsumer,
  unrecoverableQueueError,
} from '../../src/consumer.js';

import { QUEUE_NAME } from '../../src/jobs/names.js';
import { mocks } from './fixture.js';

export function registerDisconnectsBullMQBlockingOwnedRedisConnections(): void {
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
}
