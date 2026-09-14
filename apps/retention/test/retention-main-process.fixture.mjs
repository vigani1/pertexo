import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

import { bootstrapRetention } from '../dist/main.js';

const keepAlive = setInterval(() => undefined, 60_000);
const report = (event) =>
  process.stdout.write(`${JSON.stringify({ event })}\n`);
const closable = (event) => ({ close: async () => report(event) });
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
const ledger = { close: () => report('ledger.closed') };
const artifacts = { close: () => report('artifacts.closed') };
const databaseRuntime = closable('database_runtime.closed');
const database = closable('database.closed');
const enforcement = closable('enforcement.closed');
const preview = closable('preview.closed');
const runArtifacts = closable('run_artifacts.closed');
const workspacePurge = closable('workspace_purge.closed');
const region = (name) => ({
  accessKeyId: `${name}-key`,
  bucket: `${name}-bucket`,
  endpoint: `https://${name}.example.test`,
  maxObjectBytes: 1_024,
  region: name,
  requestTimeoutMs: 1_000,
  secretAccessKey: `${name}-secret`,
});
const ledgerRegion = (name) => ({
  ...region(name),
  minRetentionDays: 30,
  prefix: 'control-ledger/workspaces/',
});
const config = {
  artifactStore: { primary: region('primary'), recovery: region('recovery') },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  expectedMaintenanceRole: 'pertexo_maintenance',
  ledger: {
    primary: ledgerRegion('ledger-primary'),
    recovery: ledgerRegion('ledger-recovery'),
  },
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'retention-main-process-fixture',
    serviceVersion: 'test',
  },
  options: {
    externalOperationTimeoutMs: 1_000,
    leaseOwner: 'fixture',
    leaseSeconds: 300,
    lockTimeoutMs: 1_000,
    maxPagesPerBatch: 10,
    pageSize: 10,
    statementTimeoutMs: 1_000,
  },
  pollIntervalMs: 100,
  replicaMonitor: {
    applicationName: 'fixture-replica',
    sampleIntervalMs: 100,
  },
};

try {
  await bootstrapRetention({
    config,
    createMetrics: () => ({}),
    createTelemetryLifecycle: () => telemetry,
    loadModules: () =>
      Promise.resolve({
        artifactStore: {
          createDualRegionArtifactStore: () => artifacts,
          createDualRegionControlLedger: () => ledger,
        },
        database: {
          createDatabaseRuntime: () => databaseRuntime,
          createPreviewRetentionCoordinator: () => preview,
          createRetentionDatabase: () => database,
          createRetentionEnforcementCoordinator: () => enforcement,
          createRunArtifactRetentionCoordinator: () => runArtifacts,
          createWorkspacePurgeCoordinator: () => workspacePurge,
        },
        logging: { createStructuredLogger: () => logger },
        worker: {
          runRetentionWorker: async ({ signal }) => {
            report('worker.active');
            await new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            }).finally(async () => {
              await enforcement.close();
              await preview.close();
              await runArtifacts.close();
              await workspacePurge.close();
              await database.close();
              await databaseRuntime.close();
              artifacts.close();
              ledger.close();
              await telemetry.shutdown();
            });
          },
        },
      }),
  });
  report('bootstrap.unexpected');
  process.exitCode = 1;
} catch (error) {
  const expected =
    error instanceof Error && error.message === 'Retention worker interrupted';
  report(expected ? 'bootstrap.stopped' : 'bootstrap.unexpected');
  process.exitCode = expected ? 0 : 1;
} finally {
  clearInterval(keepAlive);
}
