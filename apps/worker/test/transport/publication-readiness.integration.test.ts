import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { createQueueProducer } from '@pertexo/queue/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WorkerReadinessMonitor } from '../../src/runtime/health/readiness-monitor.js';
import { logger } from '../runtime/readiness-lifecycle.fixture.js';
import {
  describeIntegration,
  prepareWorkerPostgreSQLRedisTransportProofFixture,
  closeWorkerPostgreSQLRedisTransportProofFixture,
  createDispatcher,
  redisUrl,
} from './dispatch.fixture.js';

describeIntegration('publication readiness during Redis write refusal', () => {
  beforeAll(prepareWorkerPostgreSQLRedisTransportProofFixture);
  afterAll(closeWorkerPostgreSQLRedisTransportProofFixture);

  it('revokes readiness while Redis answers PING but refuses writes, then recovers without restarting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pertexo-readiness-'));
    const marker = join(directory, 'ready');
    const redis = new Redis(redisUrl);
    const dispatcher = createDispatcher('readiness-write-proof');
    const monitor = new WorkerReadinessMonitor(dispatcher, logger, {
      marker: {
        setReady: ({ ready }) => writeFile(marker, String(ready)),
      },
    });
    const previous = await redis.config('GET', 'maxmemory');
    const maxmemory = previous[1];
    if (maxmemory === undefined) throw new Error('Missing Redis memory limit');
    const exitCode = process.exitCode;
    try {
      await monitor.check();
      expect(await readFile(marker, 'utf8')).toBe('true');
      await redis.config('SET', 'maxmemory', '1');
      expect(await redis.ping()).toBe('PONG');
      await expect(monitor.check()).rejects.toThrow();
      expect(await readFile(marker, 'utf8')).toBe('false');
      const warning = logger.warn.mock.calls.at(-1) as
        readonly unknown[] | undefined;
      expect(warning?.[1]).toEqual({
        recovery:
          'Redis cannot accept queue writes. Check Redis memory limits and persistence disk errors, then retry the readiness check.',
      });
      expect(process.exitCode).toBe(exitCode);
      await redis.config('SET', 'maxmemory', maxmemory);
      await monitor.check();
      expect(await readFile(marker, 'utf8')).toBe('true');
    } finally {
      await redis.config('SET', 'maxmemory', maxmemory);
      await monitor.beforeApplicationShutdown();
      await dispatcher.close();
      await redis.quit();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a delayed queue write as a timeout, revokes readiness and recovers after the pause', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'pertexo-readiness-latency-'),
    );
    const marker = join(directory, 'ready');
    const redis = new Redis(redisUrl);
    const producer = createQueueProducer({ redisUrl });
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: () => producer.waitUntilReady(100) },
      logger,
      { marker: { setReady: ({ ready }) => writeFile(marker, String(ready)) } },
    );
    try {
      await producer.waitUntilReady(5_000);
      await monitor.check();
      expect(await readFile(marker, 'utf8')).toBe('true');
      await redis.call('CLIENT', 'PAUSE', '500', 'WRITE');
      expect(await redis.ping()).toBe('PONG');
      const start = performance.now();
      await expect(monitor.check()).rejects.toMatchObject({
        name: 'QueueWriteTimedOutError',
        message:
          'Queue write readiness check timed out. Check Redis latency and connectivity, then retry the readiness check.',
      });
      expect(performance.now() - start).toBeLessThan(450);
      expect(await readFile(marker, 'utf8')).toBe('false');
      const warning = logger.warn.mock.calls.at(-1) as
        readonly unknown[] | undefined;
      expect(warning?.[1]).toEqual({
        recovery:
          'Queue write readiness check timed out. Check Redis latency and connectivity, then retry the readiness check.',
      });
      expect(JSON.stringify(warning?.[1])).not.toMatch(
        /refus|memory|persistence|disk/i,
      );
      await new Promise((resolve) => setTimeout(resolve, 550));
      await monitor.check();
      expect(await readFile(marker, 'utf8')).toBe('true');
    } finally {
      await redis.call('CLIENT', 'UNPAUSE');
      await monitor.beforeApplicationShutdown();
      await producer.close();
      await redis.quit();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
