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
// `application` fails creating the application; `started-log` fails after the
// shutdown owner is installed, the last step of a bootstrap.
const failAt = process.env.WORKER_FIXTURE_FAIL;
const logger = {
  debug: () => undefined,
  error: (event) => report(event),
  fatal: (event) => report(event),
  info: (event) => {
    if (failAt === 'started-log' && event === 'worker.started')
      throw new Error('startup log failed');
    report(event);
  },
  trace: () => undefined,
  warn: () => undefined,
};
// `fails` stands for an application whose close fails and leaves a handle
// (such as a Redis reconnect timer) holding the process open.
// `fails-after-second-signal` holds the close open until a second signal
// arrives, so a test can send that signal while closing is still under way.
const closeMode = process.env.WORKER_FIXTURE_CLOSE;
const closeFails =
  closeMode === 'fails' || closeMode === 'fails-after-second-signal';
const secondSignal =
  closeMode === 'fails-after-second-signal'
    ? new Promise((resolve) => {
        process.once('SIGINT', resolve);
      })
    : Promise.resolve();
const application = {
  async close(signal) {
    report('application.closed', { signal });
    await secondSignal;
    if (closeFails) throw new Error('application close failed');
    clearInterval(keepAlive);
  },
};
const config = {
  coordinator: {
    dueWakeupBatchSize: 1,
    dueWakeupPollIntervalMillis: 100,
    maximumAdmissions: 1,
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
    max: 1,
    ownerRole: 'pertexo_owner',
  },
  dispatcherDatabase: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
  },
  logLevel: 'silent',
  nodeAttempt: {
    heartbeatIntervalMillis: 10_000,
    leaseDurationSeconds: 30,
    workerId: 'fixture',
  },
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
    leaseDurationMillis: 30_000,
    leaseOwner: 'fixture',
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
        createWorkerApplication: () =>
          failAt === 'application'
            ? Promise.reject(new Error('application failed'))
            : Promise.resolve(application),
      },
      logging: { createStructuredLogger: () => logger },
    }),
});
report('worker.active');
