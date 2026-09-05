import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import {
  instrumentRedisCommands,
  type RedisOperationObservation,
} from '../src/redis-telemetry-contracts.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.QUEUE_INTEGRATION === 'true';
if (requested && (redisUrl === undefined || redisUrl.trim() === ''))
  throw new Error('Queue integration requires REDIS_URL');
const describeIntegration = requested ? describe : describe.skip;

describeIntegration('pinned ioredis telemetry contract', () => {
  it('observes promise-like success and failure without changing command results', async () => {
    const observations: RedisOperationObservation[] = [];
    const redis = instrumentRedisCommands(
      new Redis(redisUrl ?? '', {
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      }),
      {
        connectionEvent: () => undefined,
        operationFinished(observation) {
          observations.push(observation);
        },
      },
      'queue_producer',
    );

    try {
      await redis.connect();
      await expect(redis.ping()).resolves.toBe('PONG');
      await expect(redis.call('NOT_A_REDIS_COMMAND')).rejects.toBeDefined();
      await expect.poll(() => observations.length).toBeGreaterThanOrEqual(2);
      expect(observations.some(({ outcome }) => outcome === 'success')).toBe(
        true,
      );
      expect(observations.at(-1)?.outcome).toBe('failure');
      expect(redis.duplicate()).not.toBe(redis);
    } finally {
      redis.disconnect();
    }
  });
});
