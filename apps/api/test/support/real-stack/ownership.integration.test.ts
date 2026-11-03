import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../better-auth/real-api.support.js';
import { redisStackLeaseKey } from './lease.js';
import { createRealStack } from './stack.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'fixed real-stack Redis ownership',
  () => {
    let first: ReturnType<typeof createRealStack>;
    beforeAll(async () => {
      first = createRealStack('capacity');
      await first.create();
    }, 120000);
    afterAll(async () => {
      await first.close();
    });
    it('keeps queued work intact until the current helper releases its database', async () => {
      const second = createRealStack('capacity'),
        control = new Redis(process.env.REDIS_URL ?? '');
      const queueUrl = new URL(process.env.REDIS_URL ?? '');
      queueUrl.pathname = '/1';
      const queue = new Redis(queueUrl.toString()),
        monitor = await control.monitor();
      let pending: ReturnType<typeof second.create> | undefined;
      try {
        const owner = await control.get(redisStackLeaseKey(1));
        const attempt = Promise.withResolvers<'waiting'>();
        monitor.on('monitor', (_time: number, arguments_: string[]) => {
          if (
            arguments_[0]?.toLowerCase() === 'set' &&
            arguments_[1] === redisStackLeaseKey(1) &&
            arguments_[2] !== owner
          )
            attempt.resolve('waiting');
        });
        await queue.rpush('owned-queue-fixture', 'queued-work');
        pending = second.create();
        const outcome = await Promise.race([
          attempt.promise,
          pending.then(() => 'created'),
        ]);
        expect(await queue.lrange('owned-queue-fixture', 0, -1)).toEqual([
          'queued-work',
        ]);
        expect(outcome).toBe('waiting');
      } finally {
        await first.close();
        await pending;
        await second.close();
        monitor.disconnect();
        control.disconnect();
        queue.disconnect();
      }
    });
  },
);
