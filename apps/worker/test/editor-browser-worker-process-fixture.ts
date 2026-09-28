import { randomUUID } from 'node:crypto';
import { createOutboxDispatcherDatabase } from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { createTransportMetrics } from '@pertexo/observability/transport-metrics';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { createRedisTestNamespace } from './support/redis-test-namespace.js';
import { activateCompatibilityReleaseFixture } from './support/compatibility-release.fixture.js';
import {
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import { Pool } from 'pg';
import {
  closeEditorBrowserWorker,
  EditorBrowserWorkerShutdownError,
} from './support/editor-browser-worker-cleanup.js';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || process.send === undefined)
  throw new Error('Owned browser worker needs Redis configuration and IPC');
const namespace = createRedisTestNamespace(
  redisUrl,
  11,
  'editor-browser-pure-core',
  {
    beforeCleanup: async () => {
      if (!process.connected || process.send === undefined)
        throw new Error('Cleanup ownership cannot be verified');
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          process.off('message', message);
          if (error === undefined) resolve();
          else reject(error);
        };
        const message = (value: unknown) => {
          if (
            typeof value !== 'object' ||
            value === null ||
            !('phase' in value)
          )
            return;
          if (value.phase === 'namespace-cleanup-approved') finish();
          else if (value.phase === 'namespace-cleanup-denied')
            finish(new Error('Cleanup ownership changed; preserve namespace'));
        };
        const timer = setTimeout(() => {
          finish(new Error('Cleanup ownership verification timed out'));
        }, 5_000);
        process.on('message', message);
        process.send?.({ phase: 'namespace-cleanup-request' });
      });
    },
  },
);
let coordinator:
  Awaited<ReturnType<typeof createCoordinatorRuntime>> | undefined;
let attempts: Awaited<ReturnType<typeof createNodeAttemptRuntime>> | undefined;
let dispatcher: OutboxDispatcher | undefined;
let dispatcherDatabase:
  ReturnType<typeof createOutboxDispatcherDatabase> | undefined;
let producer: ReturnType<typeof createQueueProducer> | undefined;
const lifecycle = { starting: true, stopping: false };
function assertSetupActive(): void {
  if (lifecycle.stopping) throw new Error('Worker setup canceled');
}
function disconnect(): void {
  if (process.connected) process.disconnect();
}
let cancelConfiguration: (() => void) | undefined;
let closePromise: Promise<void> | undefined;
const drain = new WorkerDrainState();
const close = (): Promise<void> => {
  closePromise ??= (async () => {
    drain.beginDrain();
    await closeEditorBrowserWorker({
      dispatcher,
      producer,
      dispatcherDatabase,
      attempts,
      coordinator,
      namespace,
    });
  })();
  return closePromise;
};
async function finishShutdown(setupFailure?: unknown): Promise<void> {
  const phases: string[] = setupFailure === undefined ? [] : ['startup'];
  try {
    await close();
  } catch (error) {
    phases.push(
      ...(error instanceof EditorBrowserWorkerShutdownError
        ? error.phases
        : ['shutdown']),
    );
  }
  if (phases.length > 0) process.exitCode = 1;
  try {
    if (process.connected && process.send !== undefined) {
      await new Promise<void>((resolve, reject) => {
        process.send?.(
          {
            phase: 'worker-shutdown',
            success: phases.length === 0,
            failures: phases,
          },
          (error: Error | null) => {
            if (error === null) resolve();
            else reject(error);
          },
        );
      });
    }
  } catch {
    process.exitCode = 1;
  } finally {
    disconnect();
  }
}
const stop = (): void => {
  lifecycle.stopping = true;
  cancelConfiguration?.();
  // Let every in-progress constructor settle before releasing its resources.
  if (lifecycle.starting) return;
  void finishShutdown();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('disconnect', stop);

try {
  // Ownership is established before the parent API can write to this Redis DB.
  await namespace.acquire();
  assertSetupActive();
  const configuration = new Promise<unknown>((resolve, reject) => {
    process.once('message', resolve);
    cancelConfiguration = () => {
      reject(new Error('Worker configuration wait canceled'));
    };
  });
  process.send({ phase: 'namespace-ready', database: namespace.database });
  const raw = await configuration;
  cancelConfiguration = undefined;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('workerUrl' in raw) ||
    !('dispatcherUrl' in raw) ||
    !('apiUrl' in raw) ||
    !('migrationUrl' in raw) ||
    typeof raw.workerUrl !== 'string' ||
    typeof raw.dispatcherUrl !== 'string' ||
    typeof raw.apiUrl !== 'string' ||
    typeof raw.migrationUrl !== 'string'
  )
    throw new Error(
      'Owned browser worker database configuration is incomplete',
    );
  assertSetupActive();
  const inspector = new Pool({ connectionString: raw.migrationUrl, max: 1 });
  const readCurrent = async () => {
    const client = await inspector.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      const result = await client.query<{
        epoch: number;
        fingerprint: string;
        catalog_json: unknown;
      }>(
        `select current.epoch, current.fingerprint, release.catalog_json
          from app.node_compatibility_current current
          join app.node_compatibility_releases release
            on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
      );
      await client.query('commit');
      return result.rows[0];
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };
  try {
    const current = await readCurrent();
    if (current === undefined)
      throw new Error('Fresh fixture compatibility pointer is missing');
    const target = platformServingRegistryRelease('validate_activation');
    for (const release of PLATFORM_REGISTRY_RELEASE_HISTORY.filter(
      (release) =>
        release.epoch > current.epoch && release.epoch <= target.epoch,
    )) {
      assertSetupActive();
      await activateCompatibilityReleaseFixture({
        actorId: 'editor-browser-fixture',
        artifactPrefix: 'editor-browser-fixture',
        apiUrl: raw.apiUrl,
        workerUrl: raw.workerUrl,
        migrationUrl: raw.migrationUrl,
        targetRelease: release,
        readCurrent,
        reasons: {
          prepare: 'Prepare isolated pure-node browser fixture release',
          approve: 'Approve isolated pure-node browser fixture release',
          activate: 'Activate isolated pure-node browser fixture release',
        },
      });
    }
  } finally {
    await inspector.end();
  }
  assertSetupActive();
  const database = parseDatabaseConfig({
    connectionString: raw.workerUrl,
    max: 6,
  });
  coordinator = await createCoordinatorRuntime({
    database,
    maximumAdmissions: 10,
    releaseCohort: 'validate_activation',
    redisUrl: namespace.redisUrl,
  });
  assertSetupActive();
  attempts = await createNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
      releaseCohort: 'validate_activation',
      redisUrl: namespace.redisUrl,
      workerId: `editor-browser-${randomUUID()}`,
    },
    {
      // These fail closed if a supposedly pure graph tries to use a provider.
      // Registry, evaluator, durable run store and execution engine remain real.
      runtimeCapabilities: {
        connections: () => ({
          resolve: () =>
            Promise.reject(
              new Error('Provider access is outside this pure-node fixture'),
            ),
        }),
        artifacts: () => ({
          write: () =>
            Promise.reject(
              new Error('Artifacts are outside this pure-node fixture'),
            ),
        }),
      },
    },
  );
  assertSetupActive();
  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    attempts.consumer.waitUntilReady(5_000),
  ]);
  assertSetupActive();
  dispatcherDatabase = createOutboxDispatcherDatabase(
    parseDatabaseConfig({ connectionString: raw.dispatcherUrl, max: 2 }),
  );
  producer = createQueueProducer({ redisUrl: namespace.redisUrl });
  dispatcher = new OutboxDispatcher(
    dispatcherDatabase,
    producer,
    drain,
    {
      enabledJobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.executeNodeAttempt,
      ],
      batchSize: 25,
      leaseDurationMillis: 30_000,
      leaseOwner: `browser-dispatch:${randomUUID()}`,
      maxAttempts: 10,
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 50,
      retryDelayMillis: 100,
    },
    createTransportMetrics(),
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.advanceWorkflowRun, consumer: coordinator.consumer },
      { jobName: JOB_NAME.executeNodeAttempt, consumer: attempts.consumer },
    ]),
  );
  dispatcher.start();
  lifecycle.starting = false;
  process.send({
    phase: 'worker-ready',
    pid: process.pid,
    cohort: 'validate_activation',
  });
} catch (error: unknown) {
  await finishShutdown(lifecycle.stopping ? undefined : error);
}
