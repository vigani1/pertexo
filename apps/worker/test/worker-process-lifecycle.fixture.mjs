import { createWorkerApplication } from '../dist/app.js';
import { WorkerProcessShutdown } from '../dist/runtime/worker-process-shutdown.js';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

const mode = process.argv[2];
if (!['active', 'bootstrap-failure', 'disabled'].includes(mode)) {
  throw new Error('worker process lifecycle fixture mode is invalid');
}

function report(event) {
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

const database = {
  withWorkspace: async (_workspaceId, operation) => operation(undefined),
  checkCompatibility: () =>
    mode === 'bootstrap-failure'
      ? Promise.reject(new Error('fixture bootstrap failure'))
      : Promise.resolve({
          migrationHead: '0074_retention_schedule_state_rls.sql',
          postgresMajor: 18,
          role: 'pertexo_worker',
        }),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0074_retention_schedule_state_rls.sql',
      postgresMajor: 18,
      role: 'pertexo_worker',
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

const activeTimer =
  mode === 'active' ? setInterval(() => undefined, 60_000) : undefined;
const activeConsumer = {
  close: () => {
    if (activeTimer !== undefined) clearInterval(activeTimer);
    report('consumer.closed');
    return Promise.resolve({ abortedJobs: 0, forced: false });
  },
  isReady: () => true,
  waitUntilReady: () => Promise.resolve(),
};

const config = {
  coordinator: {
    dueWakeupBatchSize: 25,
    dueWakeupPollIntervalMillis: 250,
    maximumAdmissions: 32,
  },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  dispatcherDatabase: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 2,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  nodeAttempt: {
    heartbeatIntervalMillis: 10_000,
    leaseDurationSeconds: 30,
    workerId: 'process-fixture',
  },
  nodeEnv: 'test',
  nodeCompatibilityCohort: 'core',
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
    enabledJobNames: mode === 'active' ? ['advance-workflow-run'] : [],
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
    pollIntervalMillis: 250,
  },
};

try {
  const application = await createWorkerApplication(config, {
    database,
    dispatcherDatabase,
    logger,
    queueProducer,
    telemetry,
    ...(mode === 'active'
      ? {
          coordinatorRuntime: {
            consumer: activeConsumer,
            close: () => activeConsumer.close().then(() => undefined),
          },
        }
      : {}),
  });
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
