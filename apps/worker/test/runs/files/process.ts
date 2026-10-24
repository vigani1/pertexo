import { z } from 'zod';
import { fork } from 'node:child_process';
import { vi } from 'vitest';
import type { fileEnvironment } from './environment.js';

const measurementSchema = z.object({
  high: z.object({
    rss: z.number(),
    heapUsed: z.number(),
    external: z.number(),
    arrayBuffers: z.number(),
    scratchBytes: z.number(),
    scratchFiles: z.number(),
  }),
  maximumActive: z.number(),
  failed: z.number(),
  resourceDrained: z.boolean(),
  eventLoopP99Millis: z.number(),
  eventLoopMaxMillis: z.number(),
});
export type WorkerMeasurement = z.infer<typeof measurementSchema>;

export async function measuredWorker(
  environment: Awaited<ReturnType<typeof fileEnvironment>>,
) {
  let active = 0,
    maximumActive = 0;
  let result: WorkerMeasurement | undefined;
  let ready = false;
  let errors = '';
  const child = fork(
    new URL('./worker-process.fixture.ts', import.meta.url),
    [],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: environment.fixture.databaseUrl(
          environment.fixture.workerUrl,
        ),
        DATABASE_MAINTENANCE_URL: environment.fixture.databaseUrl(
          environment.fixture.dispatcherUrl,
        ),
        REDIS_URL: environment.fixture.redisUrl,
        ARTIFACT_SCRATCH_DIRECTORY: environment.scratch.directory,
        HTTP_ALLOWED_PRIVATE_NETWORKS: '127.0.0.1/32',
      },
    },
  );
  child.stderr?.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-8000);
  });
  child.on('message', (message: unknown) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('phase' in message)
    )
      return;
    if (message.phase === 'ready') ready = true;
    if (
      message.phase === 'sample' &&
      'active' in message &&
      typeof message.active === 'number' &&
      'maximumActive' in message &&
      typeof message.maximumActive === 'number'
    ) {
      active = message.active;
      maximumActive = message.maximumActive;
    }
    if (message.phase === 'closed') result = measurementSchema.parse(message);
  });
  async function until(check: () => boolean) {
    await vi.waitUntil(
      () => {
        if (child.exitCode !== null)
          throw new Error(`Measured worker unavailable: ${errors}`);
        return check();
      },
      { timeout: 15_000, interval: 25 },
    );
  }
  await until(() => ready);
  return {
    get active() {
      return active;
    },
    get maximumActive() {
      return maximumActive;
    },
    async close() {
      child.kill('SIGTERM');
      await until(() => result !== undefined);
      await until(() => child.exitCode !== null);
      if (child.exitCode !== 0 || result === undefined)
        throw new Error(`Measured worker cleanup failed: ${errors}`);
      return result;
    },
  };
}
