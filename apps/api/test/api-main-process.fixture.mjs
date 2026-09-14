import process from 'node:process';

import { bootstrapApi } from '../dist/main.js';

const application = {
  close: async () => {
    process.stdout.write('{"event":"application.closed"}\n');
    await telemetry.shutdown();
  },
  listen: async () => {
    throw new Error('fixture listen failure');
  },
};
const telemetry = {
  enabled: false,
  started: false,
  start() {
    this.started = true;
    process.stdout.write('{"event":"telemetry.started"}\n');
  },
  async shutdown() {
    process.stdout.write('{"event":"telemetry.closed"}\n');
  },
};
const logger = {
  debug: () => undefined,
  error: (event) => process.stdout.write(`${JSON.stringify({ event })}\n`),
  fatal: (event) => process.stdout.write(`${JSON.stringify({ event })}\n`),
  info: (event) => process.stdout.write(`${JSON.stringify({ event })}\n`),
  trace: () => undefined,
  warn: () => undefined,
};
const config = {
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  host: '127.0.0.1',
  nodeCompatibilityCohort: 'core',
  nodeEnv: 'test',
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'api-main-process-fixture',
    serviceVersion: 'test',
  },
  port: 4312,
  redisUrl: 'redis://localhost:6379/0',
  trustedProxyCidrs: [],
};

try {
  await bootstrapApi({
    config,
    createTelemetryLifecycle: () => telemetry,
    loadModules: () =>
      Promise.resolve({
        application: {
          createApiApplication: () => Promise.resolve(application),
        },
        logging: { createStructuredLogger: () => logger },
      }),
  });
  process.stdout.write('{"event":"bootstrap.unexpected"}\n');
  process.exitCode = 1;
} catch (error) {
  const expected =
    error instanceof Error && error.message === 'fixture listen failure';
  process.stdout.write(
    `${JSON.stringify({ event: expected ? 'bootstrap.failed' : 'bootstrap.unexpected' })}\n`,
  );
  process.exitCode = expected ? 0 : 1;
}
