import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

import { bootstrapRecovery } from '../dist/main.js';

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
const ledger = { close: () => report('ledger.closed') };
const artifacts = { close: () => report('artifacts.closed') };
const coordinator = { close: async () => report('coordinator.closed') };
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
  artifacts: { primary: region('primary'), recovery: region('recovery') },
  coordinator: {
    artifactPageSize: 10,
    externalOperationTimeoutMs: 1_000,
    inventoryPageSize: 10,
    lockTimeoutMs: 1_000,
    maxArtifactPages: 10,
    maxInventoryPages: 10,
    maxInventorySweeps: 1,
    maxPages: 10,
    maxRecords: 100,
    maxWorkspaceReconcileAttempts: 1,
    pageSize: 10,
    statementTimeoutMs: 1_000,
  },
  database: {
    connectionString: 'postgresql://unused',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  ledger: {
    primary: ledgerRegion('ledger-primary'),
    recovery: ledgerRegion('ledger-recovery'),
  },
  maintenanceRole: 'pertexo_maintenance',
  observability: {
    environment: 'test',
    logLevel: 'silent',
    otlpHeaders: {},
    serviceName: 'recovery-main-process-fixture',
    serviceVersion: 'test',
  },
  timeoutMs: 30_000,
};

try {
  await bootstrapRecovery({
    config,
    createTelemetryLifecycle: () => telemetry,
    loadModules: () =>
      Promise.resolve({
        artifactStore: {
          createDualRegionArtifactStore: () => artifacts,
          createDualRegionControlLedger: () => ledger,
        },
        database: { createControlLedgerCoordinator: () => coordinator },
        logging: { createStructuredLogger: () => logger },
        observability: {
          createMaintenanceMetrics: () => ({
            recordControlLedgerReconciliation: () => undefined,
            recordLifecycleCommand: () => undefined,
          }),
        },
        recovery: {
          restoreBeforeServe: async ({ signal }) => {
            report('recovery.active');
            await new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            }).finally(async () => {
              await coordinator.close();
              ledger.close();
              artifacts.close();
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
    error instanceof Error && error.message === 'Restore recovery interrupted';
  report(expected ? 'bootstrap.stopped' : 'bootstrap.unexpected');
  process.exitCode = expected ? 0 : 1;
} finally {
  clearInterval(keepAlive);
}
