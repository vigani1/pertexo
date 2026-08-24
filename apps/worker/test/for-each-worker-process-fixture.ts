import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database';
import { PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';

const databaseUrl = process.env.FOR_EACH_DATABASE_URL;
const redisUrl = process.env.FOR_EACH_REDIS_URL;
if (databaseUrl === undefined || redisUrl === undefined)
  throw new Error('For Each process fixture configuration is incomplete');

const database = parseDatabaseConfig({ connectionString: databaseUrl, max: 6 });
const coordinator = await createCoordinatorRuntime({
  database,
  maximumAdmissions: 10,
  releaseCohort: 'for_each_activation',
  redisUrl,
});
const attempts = await createNodeAttemptRuntime(
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
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await Promise.allSettled([attempts.close(), coordinator.close()]);
  process.exit(0);
};
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
