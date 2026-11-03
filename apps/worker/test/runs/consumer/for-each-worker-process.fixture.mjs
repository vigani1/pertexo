// @ts-check
import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createPlatformNodeRegistry } from '../../../dist/providers/node-registry.js';
import { createCoordinatorRuntime } from '../../../dist/runs/coordinator.runtime.js';
import { createNodeAttemptRuntime } from '../../../dist/attempts/delivery/node-attempt.runtime.js';
const databaseUrl = process.env.FOR_EACH_DATABASE_URL;
const maintenanceDatabaseUrl = process.env.FOR_EACH_MAINTENANCE_DATABASE_URL;
const redisUrl = process.env.FOR_EACH_REDIS_URL;
if (
  databaseUrl === undefined ||
  maintenanceDatabaseUrl === undefined ||
  redisUrl === undefined
)
  throw new Error('For Each process fixture configuration is incomplete');
const database = parseDatabaseConfig({ connectionString: databaseUrl, max: 6 });
/** @type {Awaited<ReturnType<typeof createCoordinatorRuntime>> | undefined} */
let coordinator;
/** @type {Awaited<ReturnType<typeof createNodeAttemptRuntime>> | undefined} */
let attempts;
/** @type {Promise<void> | undefined} */
let closePromise;
const close = () => {
  closePromise ??= (async () => {
    /** @type {unknown[]} */
    const errors = [];
    await attempts?.close().catch((error) => errors.push(error));
    await coordinator?.close().catch((error) => errors.push(error));
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'For Each process fixture shutdown failed',
      );
  })();
  return closePromise;
};
const handleSignal = () => {
  void close().then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'For Each process fixture shutdown failed'}\n`,
      );
      process.exitCode = 1;
    },
  );
};
process.once('SIGTERM', handleSignal);
process.once('SIGINT', handleSignal);
// The test keeps loaded spares so each restart costs only connection setup.
// A spare has opened no Redis or PostgreSQL connection until it is started.
process.stdout.write(`${JSON.stringify({ loaded: true, pid: process.pid })}\n`);
const started = await new Promise((resolve) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.includes('\n')) resolve(input.startsWith('start\n'));
  });
  process.stdin.once('end', () => {
    resolve(false);
  });
});
process.stdin.destroy();
if (!started) process.exit(0);
try {
  coordinator = await createCoordinatorRuntime({
    maintenanceDatabase: parseDatabaseConfig({
      connectionString: maintenanceDatabaseUrl,
      max: 2,
    }),
    database,
    maximumAdmissions: 10,
    redisUrl,
  });
  attempts = await createNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
      redisUrl,
      workerId: `for-each-process-${randomUUID()}`,
    },
    {
      registry: () => createPlatformNodeRegistry(),
      capabilities: () =>
        Promise.resolve({
          factories: {
            connections: () => ({
              resolve: () => Promise.reject(new Error('not used')),
            }),
            artifacts: () => ({
              write: () => Promise.reject(new Error('not used')),
            }),
          },
          checkReadiness: () => Promise.resolve(),
          checkObjectStore: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
    },
  );
  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    attempts.consumer.waitUntilReady(5_000),
  ]);
  process.stdout.write(
    `${JSON.stringify({ ready: true, pid: process.pid })}\n`,
  );
} catch (startupError) {
  process.removeListener('SIGTERM', handleSignal);
  process.removeListener('SIGINT', handleSignal);
  let cleanupError;
  await close().catch((error) => {
    cleanupError = error;
  });
  if (cleanupError === undefined) throw startupError;
  throw new AggregateError(
    [startupError, cleanupError],
    'For Each process fixture startup failed',
  );
}
