import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

import { bootstrapWorker } from '../dist/main.js';

const keepAlive = setInterval(() => undefined, 60_000);
const report = (event, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const telemetry = {
  enabled: false,
  started: false,
  start() {
    this.started = true;
    report('telemetry.started');
  },
  async shutdown() {
    report('telemetry.closed');
  },
};
const logger = {
  debug: () => undefined,
  error: (event) => report(event),
  fatal: (event) => report(event),
  info: (event) => report(event),
  trace: () => undefined,
  warn: () => undefined,
};
const application = {
  async close(signal) {
    report('application.closed', { signal });
    clearInterval(keepAlive);
  },
};
const config = {
  coordinator: {
    dueWakeupBatchSize: 1,
    dueWakeupPollIntervalMillis: 100,
    maximumAdmissions: 1,
    runTimeoutFailureContextEnabled: false,
  },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  dispatcherDatabase: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  logLevel: 'silent',
  nodeAttempt: {
    heartbeatIntervalMillis: 10_000,
    leaseDurationSeconds: 30,
    workerId: 'fixture',
  },
  nodeCompatibilityCohort: 'core',
  nodeEnv: 'test',
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'worker-main-process-fixture',
    serviceVersion: 'test',
  },
  outboxDispatcher: {
    batchSize: 1,
    enabledJobNames: [],
    leaseDurationMillis: 30_000,
    leaseOwner: 'fixture',
    maxAttempts: 1,
    operationTimeoutMillis: 1_000,
    pollIntervalMillis: 100,
    retryDelayMillis: 100,
  },
  redisUrl: 'redis://localhost:6379/0',
  resourceSafety: {
    maximumEventLoopDelayMillis: 200,
    maximumRssBytes: 805_306_368,
    sampleIntervalMillis: 5_000,
    unhealthySamplesBeforeDrain: 3,
  },
  triggerRuntime: {
    batchSize: 1,
    leaseDurationSeconds: 30,
    leaseOwner: 'fixture',
    onTimeWindowSeconds: 300,
    pollIntervalMillis: 100,
  },
};

await bootstrapWorker({
  config,
  createTelemetryLifecycle: () => telemetry,
  loadModules: () =>
    Promise.resolve({
      application: {
        createWorkerApplication: () => Promise.resolve(application),
      },
      logging: { createStructuredLogger: () => logger },
    }),
});
report('worker.active');
