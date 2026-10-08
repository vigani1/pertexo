import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

import { bootstrapOperatorCommand } from '../dist/main.js';

const mode = process.argv[2];
if (!['active', 'success'].includes(mode))
  throw new Error('operator main process fixture mode is invalid');
const keepAlive = setInterval(() => undefined, 60_000);
const report = (event) =>
  process.stdout.write(`${JSON.stringify({ event })}\n`);
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
const database = { close: async () => report('database.closed') };
const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = {
  cleanupTimeoutMs: 10_000,
  command: {
    actorRef: 'fixture',
    commandId,
    reason: 'process fixture',
    type: 'operator.status',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  forbiddenRoles: ['pertexo_owner'],
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'operator-main-process-fixture',
    serviceVersion: 'test',
  },
  operatorRole: 'pertexo_operator',
  timeoutMs: 30_000,
};

try {
  await bootstrapOperatorCommand({
    config,
    createTelemetryLifecycle: () => telemetry,
    loadModules: () =>
      Promise.resolve({
        command: {
          runOperatorCommand: async ({ signal }) => {
            if (mode === 'success') {
              return { commandId, outcome: 'not_found', status: 'missing' };
            }
            report('command.active');
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  report('command.closed');
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          },
        },
        database: { createOperatorCommandDatabase: () => database },
        logging: { createStructuredLogger: () => logger },
      }),
  });
  if (mode === 'active') {
    report('bootstrap.unexpected');
    process.exitCode = 1;
  }
} catch (error) {
  const expected =
    mode === 'active' &&
    error instanceof Error &&
    error.message === 'Operator command interrupted';
  report(expected ? 'bootstrap.stopped' : 'bootstrap.unexpected');
  process.exitCode = expected ? 0 : 1;
} finally {
  clearInterval(keepAlive);
}
