import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

import { bootstrapLifecycleCommand } from '../dist/main.js';
import { createLifecycleCommandReadinessMarker } from '../dist/readiness-marker.js';
import { runLifecycleCommandWorker } from '../dist/run.js';

const mode = process.argv[2];
const markerPath = process.argv[3];

if (
  !['active', 'bootstrap-failure'].includes(mode) ||
  typeof markerPath !== 'string' ||
  markerPath.length === 0
)
  throw new Error('lifecycle command process fixture mode is invalid');

function report(event) {
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

const telemetry = {
  enabled: false,
  started: false,
  start() {
    this.started = true;
    report('telemetry.started');
  },
  shutdown() {
    report('telemetry.closed');
    return Promise.resolve();
  },
};

const productionReadiness = createLifecycleCommandReadinessMarker(markerPath);
const readiness = {
  clear: async () => {
    await productionReadiness.clear();
    report('readiness.cleared');
  },
  mark: async () => {
    await productionReadiness.mark();
    report('readiness.marked');
  },
};

const ledger = {
  append: () => undefined,
  checkReadiness: async () => ({
    bucket: 'primary',
    minRetentionDays: 30,
    prefix: 'control-ledger/workspaces/',
    primary: {
      bucket: 'primary',
      minRetentionDays: 30,
      prefix: 'control-ledger/workspaces/',
      region: 'eu-central-1',
    },
    recovery: {
      bucket: 'recovery',
      minRetentionDays: 30,
      prefix: 'control-ledger/workspaces/',
      region: 'eu-west-1',
    },
    region: 'eu-central-1',
  }),
  close: () => report('ledger.closed'),
  read: () => undefined,
  reconcile: () => undefined,
};

const coordinator = {
  checkReadiness: async () => report('database.ready'),
  close: async () => report('database.closed'),
  processNext: ({ signal } = {}) => {
    report('worker.active');
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  },
};

const logger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: (event) => report(event),
  info: (event) => report(event),
  trace: () => undefined,
  warn: () => undefined,
};

const config = {
  coordinator: {
    externalOperationTimeoutMs: 30_000,
    leaseDurationMs: 180_000,
    leaseOwner: 'lifecycle-process-fixture',
    lockTimeoutMs: 10_000,
    statementTimeoutMs: 30_000,
  },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_lifecycle_command',
  },
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  ledger: {
    primary: {
      accessKeyId: 'primary-key',
      bucket: 'primary',
      endpoint: 'https://primary.example.test',
      minRetentionDays: 30,
      region: 'eu-central-1',
      secretAccessKey: 'primary-secret',
    },
    recovery: {
      accessKeyId: 'recovery-key',
      bucket: 'recovery',
      endpoint: 'https://recovery.example.test',
      minRetentionDays: 30,
      region: 'eu-west-1',
      secretAccessKey: 'recovery-secret',
    },
  },
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'pertexo-lifecycle-command-process-fixture',
    serviceVersion: 'test',
  },
  pollIntervalMs: 100,
};

const modules = {
  artifactStore: {
    createDualRegionControlLedger: () => ledger,
  },
  database: {
    createWorkspaceLifecycleCommandCoordinator: () => {
      if (mode === 'bootstrap-failure')
        throw new Error('fixture coordinator construction failure');
      return coordinator;
    },
  },
  logging: {
    createStructuredLogger: () => logger,
  },
  observability: {
    createMaintenanceMetrics: () => ({
      recordControlLedgerReconciliation: () => undefined,
      recordLifecycleCommand: () => undefined,
    }),
  },
  worker: { runLifecycleCommandWorker },
};

const keepAlive = setInterval(() => undefined, 60_000);
try {
  await bootstrapLifecycleCommand({
    config,
    createReadinessMarker: () => readiness,
    createTelemetryLifecycle: () => telemetry,
    loadModules: () => Promise.resolve(modules),
  });
  report('bootstrap.completed');
} catch (error) {
  report(
    error instanceof Error &&
      error.message === 'fixture coordinator construction failure'
      ? 'bootstrap.failed'
      : 'bootstrap.unexpected',
  );
  process.exitCode =
    error instanceof Error &&
    error.message === 'fixture coordinator construction failure'
      ? 0
      : 1;
} finally {
  clearInterval(keepAlive);
}
