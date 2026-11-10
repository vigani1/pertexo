import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

const describeIntegration =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true'
    ? describe
    : describe.skip;

// This file owns no consumer fixture: its child exercises that fixture's failed setup.
describeIntegration('preview fixture setup failure', () => {
  it('preserves a Redis acquisition failure without closing pools that were never created', async () => {
    const redis = new Redis(
      process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0',
      {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      },
    );
    const marker = `pertexo:test:preview-setup-failure:${randomUUID()}`;
    try {
      await redis.connect();
      await redis.select(10);
      expect(await redis.get('pertexo:test:redis-db:13:owner')).toBeNull();
      await redis.select(13);
      expect(await redis.dbsize()).toBe(0);
      await redis.set(marker, 'owned by setup-failure test');
      // Keep the child bounded and finished before this test removes its marker.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')),
          ),
          'run',
          '--config',
          'vitest.integration.config.ts',
          'test/previews/consumer/delivery.integration.test.ts',
          '--maxWorkers=1',
        ],
        {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: process.env,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Redis test database 13 is not empty');
      expect(output).not.toContain('Preview integration cleanup failed');
      expect(output).not.toContain(
        "Cannot read properties of undefined (reading 'end')",
      );
      expect(await redis.get(marker)).toBe('owned by setup-failure test');
    } finally {
      await redis.del(marker);
      await redis.quit();
    }
  }, 45_000);
});
