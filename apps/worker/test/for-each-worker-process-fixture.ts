import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/testing';
import { PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';

const databaseUrl = process.env.FOR_EACH_DATABASE_URL;
const redisUrl = process.env.FOR_EACH_REDIS_URL;
if (databaseUrl === undefined || redisUrl === undefined)
  throw new Error('For Each process fixture configuration is incomplete');

const database = parseDatabaseConfig({ connectionString: databaseUrl, max: 6 });
let coordinator:
  Awaited<ReturnType<typeof createCoordinatorRuntime>> | undefined;
let attempts: Awaited<ReturnType<typeof createNodeAttemptRuntime>> | undefined;
let closePromise: Promise<void> | undefined;

const close = (): Promise<void> => {
  closePromise ??= (async () => {
    const errors: unknown[] = [];
    await attempts?.close().catch((error: unknown) => errors.push(error));
    await coordinator?.close().catch((error: unknown) => errors.push(error));
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'For Each process fixture shutdown failed',
      );
  })();
  return closePromise;
};

const handleSignal = (): void => {
  void close().then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'For Each process fixture shutdown failed'}\n`,
      );
      process.exitCode = 1;
    },
  );
};
process.once('SIGTERM', handleSignal);
process.once('SIGINT', handleSignal);

try {
  coordinator = await createCoordinatorRuntime({
    database,
    maximumAdmissions: 10,
    releaseCohort: 'for_each_activation',
    redisUrl,
  });
  attempts = await createNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
      releaseCohort: 'for_each_activation',
      redisUrl,
      workerId: `for-each-process-${randomUUID()}`,
    },
    {
      registry: createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
      ),
      runtimeCapabilities: {
        connections: () => ({
          resolve: () => Promise.reject(new Error('not used')),
        }),
        artifacts: () => ({
          write: () => Promise.reject(new Error('not used')),
        }),
      },
    },
  );

  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    attempts.consumer.waitUntilReady(5_000),
  ]);
  process.stdout.write(
    `${JSON.stringify({ ready: true, pid: process.pid })}\n`,
  );
} catch (startupError: unknown) {
  process.removeListener('SIGTERM', handleSignal);
  process.removeListener('SIGINT', handleSignal);
  let cleanupError: unknown;
  await close().catch((error: unknown) => {
    cleanupError = error;
  });
  if (cleanupError === undefined) throw startupError;
  throw new AggregateError(
    [startupError, cleanupError],
    'For Each process fixture startup failed',
  );
}
