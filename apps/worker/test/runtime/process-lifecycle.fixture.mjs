import { Test } from '@nestjs/testing';
import { createDatabaseRuntime } from '@pertexo/database/platform';
import { createWorkerApplication } from '../../dist/app.js';
import { WORKSPACE_INBOX_RUNTIME } from '../../dist/notifications/inbox-runtime.js';
import { WORKSPACE_DATABASE } from '../../dist/platform/database/module.js';
import { RETENTION_RUNTIME } from '../../dist/retention/runtime.js';
import { WorkerReadiness } from '../../dist/runtime/health/readiness.js';
import { WorkerReadinessMonitor } from '../../dist/runtime/health/readiness-monitor.js';
import { WorkerDrainState } from '../../dist/runtime/shutdown/drain-state.js';
import { WorkerProcessShutdown } from '../../dist/runtime/shutdown/process.js';
import {
  COORDINATOR_RUNTIME,
  MAINTENANCE_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  TRANSPORT_METRICS,
  TRIGGER_RUNTIME,
} from '../../dist/transport/module.js';
import { OutboxDispatcher } from '../../dist/transport/outbox/dispatch/runtime.js';
import { createOwnedOutboxDispatcher } from '../../dist/transport/providers/dispatcher.js';
import { WORKFLOW_AUTO_PAUSE_RUNTIME } from '../../dist/workflows/auto-pause-runtime.js';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

const mode = process.argv[2];
if (!['active', 'bootstrap-failure', 'disabled', 'held-open'].includes(mode)) {
  throw new Error('worker process lifecycle fixture mode is invalid');
}

function report(event) {
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

const database = {
  withWorkspace: async (_workspaceId, operation) => operation(undefined),
  checkReadiness: () =>
    mode === 'bootstrap-failure'
      ? Promise.reject(new Error('fixture bootstrap failure'))
      : Promise.resolve({
          migrationHead: '0076_replay_lineage_retention.sql',
          postgresMajor: 18,
          role: 'pertexo_app',
        }),
  close: () => {
    report('database.closed');
    return Promise.resolve();
  },
};

const dispatcherDatabase = {
  checkReadiness: () => Promise.resolve(),
  claimBatch: () => Promise.resolve({ events: [], exhaustedCount: 0 }),
  close: () => Promise.resolve(),
  markPublished: () => Promise.resolve(true),
  observeBacklog: () => Promise.resolve({ backlog: 0 }),
  releaseOrFail: () => Promise.resolve('retry_scheduled'),
};

const queueProducer = {
  close: () => Promise.resolve(),
  isReady: () => true,
  observe: () => Promise.resolve([]),
  publish: () => Promise.reject(new Error('fixture does not publish')),
  waitUntilReady: () => Promise.resolve(),
};

const logger = Object.fromEntries(
  ['debug', 'error', 'fatal', 'info', 'trace', 'warn'].map((level) => [
    level,
    () => undefined,
  ]),
);
const telemetry = {
  enabled: false,
  started: true,
  start: () => undefined,
  shutdown: () => {
    report('telemetry.closed');
    return Promise.resolve();
  },
};
const readinessMarker = {
  setReady: () => Promise.resolve(),
};

const activeTimer =
  mode === 'active' ? setInterval(() => undefined, 60_000) : undefined;
// Like a reconnect timer left by a client that couldn't close: nothing clears it.
if (mode === 'held-open') setInterval(() => undefined, 60_000);
const activeConsumer = {
  close: () => {
    if (activeTimer !== undefined) clearInterval(activeTimer);
    report('consumer.closed');
    return Promise.resolve({ abortedJobs: 0, forced: false });
  },
  isReady: () => true,
  waitUntilReady: () => Promise.resolve(),
};

const idleConsumer = {
  close: () => Promise.resolve({ abortedJobs: 0, forced: false }),
  isReady: () => true,
  waitUntilReady: () => Promise.resolve(),
};
const idleRuntime = (consumer = idleConsumer) => ({
  consumer,
  start: () => undefined,
  checkReadiness: () => Promise.resolve(),
  close: () => consumer.close().then(() => undefined),
});

const config = {
  coordinator: {
    dueWakeupBatchSize: 25,
    dueWakeupPollIntervalMillis: 250,
    maximumAdmissions: 32,
  },
  workspaceInbox: {
    foldBatchSize: 500,
    foldPollMillis: 1_000,
  },
  workflowAutoPause: {
    foldBatchSize: 500,
    foldPollMillis: 1_000,
  },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
  },
  dispatcherDatabase: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 2,
    ownerRole: 'pertexo_owner',
  },
  nodeAttempt: {
    heartbeatIntervalMillis: 10_000,
    leaseDurationSeconds: 30,
    workerId: 'process-fixture',
  },
  nodeEnv: 'test',
  logLevel: 'silent',
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'pertexo-worker-process-fixture',
    serviceVersion: 'test',
  },
  outboxDispatcher: {
    batchSize: 10,
    leaseDurationMillis: 30_000,
    leaseOwner: 'process-fixture',
    maxAttempts: 3,
    operationTimeoutMillis: 5_000,
    pollIntervalMillis: 250,
    retryDelayMillis: 1_000,
  },
  redisUrl: 'redis://unused',
  resourceSafety: {
    maximumEventLoopDelayMillis: 200,
    maximumRssBytes: 805_306_368,
    sampleIntervalMillis: 5_000,
    unhealthySamplesBeforeDrain: 3,
  },
  triggerRuntime: {
    batchSize: 25,
    leaseDurationSeconds: 30,
    leaseOwner: 'process-fixture',
    onTimeWindowSeconds: 300,
    pollIntervalMillis: 250,
  },
};

try {
  const application = await createWorkerApplication(
    config,
    { logger, telemetry },
    {
      applicationContext: async (module, options) => {
        const builder = Test.createTestingModule({ imports: [module] });
        const idle = {
          start: () => undefined,
          checkReadiness: () => Promise.resolve(),
          close: () => Promise.resolve(),
        };
        for (const [token, value] of [
          [WORKSPACE_DATABASE, database],
          [WORKSPACE_INBOX_RUNTIME, idle],
          // Every runtime is composed; only an active fixture holds a consumer open.
          [
            COORDINATOR_RUNTIME,
            idleRuntime(mode === 'active' ? activeConsumer : idleConsumer),
          ],
          [NODE_ATTEMPT_RUNTIME, idleRuntime()],
          [MAINTENANCE_RUNTIME, idleRuntime()],
          [TRIGGER_RUNTIME, idleRuntime()],
          [WORKFLOW_AUTO_PAUSE_RUNTIME, idleRuntime()],
          [RETENTION_RUNTIME, idleRuntime()],
        ])
          builder.overrideProvider(token).useValue(value);
        builder.overrideProvider(OUTBOX_DISPATCHER).useFactory({
          inject: [WorkerDrainState, TRANSPORT_METRICS],
          factory: (drainState, metrics) =>
            createOwnedOutboxDispatcher(
              config,
              {},
              {
                drainState,
                metrics,
                factories: {
                  database: () => dispatcherDatabase,
                  producer: () => queueProducer,
                  dispatcher: (selected, producer, input) =>
                    new OutboxDispatcher(selected, producer, input),
                },
              },
            ),
        });
        builder.overrideProvider(WorkerReadinessMonitor).useFactory({
          inject: [WorkerReadiness],
          factory: (readiness) =>
            new WorkerReadinessMonitor(readiness, logger, {
              marker: readinessMarker,
              failClosed: undefined,
              operationTimeoutMillis:
                config.outboxDispatcher.operationTimeoutMillis,
            }),
        });
        builder.setLogger(options.logger);
        const testing = await builder.compile();
        return testing.init();
      },
      databaseRuntime: createDatabaseRuntime,
      callbackStore: () => ({
        async *keysInUse() {
          yield* await Promise.resolve([]);
        },
        close: () => Promise.resolve(),
      }),
    },
  );
  new WorkerProcessShutdown(application, logger).install();
  report('worker.ready');
} catch (error) {
  if (activeTimer !== undefined) clearInterval(activeTimer);
  report(
    error instanceof Error && error.message === 'fixture bootstrap failure'
      ? 'bootstrap.failed'
      : 'bootstrap.unexpected',
  );
  process.exitCode =
    error instanceof Error && error.message === 'fixture bootstrap failure'
      ? 0
      : 1;
}
