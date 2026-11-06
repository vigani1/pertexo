import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const integration = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const vitest = join(require.resolve('vitest/package.json'), '..', 'vitest.mjs');

describe.skipIf(!integration)(
  'Redis ownership after a real Vitest timeout',
  () => {
    it('leaves a clean database for a fresh file even when the first body never finishes', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pertexo-redis-timeout-'));
      const namespaceModule = fileURLToPath(
        new URL('./redis-test-namespace.ts', import.meta.url),
      );
      const cleanupModule = fileURLToPath(
        new URL('./test-resource-cleanup.ts', import.meta.url),
      );
      const config = join(directory, 'vitest.config.mjs');
      const fixture = join(directory, 'ownership.test.ts');
      const report = join(directory, 'result.json');
      try {
        await writeFile(
          config,
          `export default { test: { root: ${JSON.stringify(directory)}, globals: true, reporters: ['default', 'json'], outputFile: ${JSON.stringify(report)} } };`,
        );
        const source = `import { createRedisTestNamespace } from ${JSON.stringify(namespaceModule)};
import { registerTestResourceCleanup } from ${JSON.stringify(cleanupModule)};
const namespace = createRedisTestNamespace(process.env.REDIS_URL, 9, 'timeout-regression');
it('times out after owning Redis', async (context) => {
  const close = registerTestResourceCleanup(context, () => namespace.close());
  try {
    await namespace.acquire();
    const { Redis } = await import(${JSON.stringify(require.resolve('ioredis'))});
    const client = new Redis(namespace.redisUrl);
    try { await client.set('timeout-marker', 'must-be-flushed'); } finally { await client.quit(); }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(${JSON.stringify(join(directory, 'seeded'))}, 'seeded');
    await new Promise(() => {});
  } finally { await close(); }
}, 250);
`;
        await writeFile(fixture, source);
        const first = await run(
          process.execPath,
          [vitest, 'run', '--config', config],
          { timeout: 15_000 },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(first).toBeInstanceOf(Error);
        expect(await readFile(join(directory, 'seeded'), 'utf8')).toBe(
          'seeded',
        );
        expect(first).toMatchObject({ code: 1 });
        expect((first as { stderr: string }).stderr).toContain(
          'Test timed out in 250ms',
        );
        await writeFile(
          fixture,
          `import { createRedisTestNamespace } from ${JSON.stringify(namespaceModule)};
it('acquires the clean Redis database in a fresh file', async () => {
  const namespace = createRedisTestNamespace(process.env.REDIS_URL, 9, 'next-file');
  await namespace.acquire();
  await namespace.close();
});`,
        );
        await expect(
          run(process.execPath, [vitest, 'run', '--config', config], {
            timeout: 15_000,
          }),
        ).resolves.toBeDefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 35_000);
  },
);
