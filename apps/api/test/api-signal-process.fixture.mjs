import process from 'node:process';

import { createApiApplication } from '../dist/app.js';

const events = (event) =>
  process.stdout.write(`${JSON.stringify({ event })}\n`);
const database = {
  checkCompatibility: () => Promise.resolve(),
  checkReadiness: () => Promise.resolve(),
  close: async () => {
    events('database.closed');
    if (process.env.DB_CLOSE_FAIL === '1')
      throw new Error('fixture database close failed');
  },
  withWorkspace: () => Promise.reject(new Error('fixture route not used')),
};
const telemetry = {
  enabled: false,
  started: true,
  start: () => undefined,
  shutdown: async () => events('telemetry.closed'),
};
const logger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};
const application = await createApiApplication(
  {
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
      serviceName: 'api-signal-process-fixture',
      serviceVersion: 'test',
    },
    port: 0,
    redisUrl: 'redis://unused',
    trustedProxyCidrs: [],
  },
  {
    database,
    logger,
    rateLimitConsumer: { consume: () => Promise.resolve({ allowed: true }) },
    telemetry,
  },
);
await application.listen({ host: '127.0.0.1', port: 0 });
events('application.ready');
