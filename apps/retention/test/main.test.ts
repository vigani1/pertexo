import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { parseRetentionWorkerConfig } from '../src/config.js';
import {
  bootstrapRetention,
  type RetentionBootstrapModules,
} from '../src/main.js';

const config = parseRetentionWorkerConfig({
  ARTIFACT_STORE_ACCESS_KEY_ID: 'artifact-primary-key',
  ARTIFACT_STORE_BUCKET: 'artifacts-primary',
  ARTIFACT_STORE_ENDPOINT: 'https://primary.example.test',
  ARTIFACT_STORE_REGION: 'eu-central-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'artifact-primary-secret',
  ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'artifact-recovery-key',
  ARTIFACT_STORE_RECOVERY_BUCKET: 'artifacts-recovery',
  ARTIFACT_STORE_RECOVERY_ENDPOINT: 'https://recovery.example.test',
  ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
  ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'artifact-recovery-secret',
  CONTROL_LEDGER_ACCESS_KEY_ID: 'ledger-primary-key',
  CONTROL_LEDGER_BUCKET: 'ledger-primary',
  CONTROL_LEDGER_ENDPOINT: 'https://primary.example.test',
  CONTROL_LEDGER_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_REGION: 'eu-central-1',
  CONTROL_LEDGER_SECRET_ACCESS_KEY: 'ledger-primary-secret',
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: 'ledger-recovery-key',
  CONTROL_LEDGER_RECOVERY_BUCKET: 'ledger-recovery',
  CONTROL_LEDGER_RECOVERY_ENDPOINT: 'https://recovery.example.test',
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_RECOVERY_REGION: 'eu-west-1',
  CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY: 'ledger-recovery-secret',
  DATABASE_MAINTENANCE_URL:
    'postgresql://maintenance:secret@localhost:5432/pertexo',
  NODE_ENV: 'test',
  RETENTION_LEASE_OWNER: 'retention-main-test',
});

function processDouble() {
  const listeners = new Map<string, () => void>();
  return {
    emit(signal: 'SIGINT' | 'SIGTERM') {
      listeners.get(signal)?.();
    },
    once: vi.fn((signal: string, listener: () => void) => {
      listeners.set(signal, listener);
    }),
    removeListener: vi.fn((signal: string, listener: () => void) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    }),
  };
}

function closable() {
  return { close: vi.fn(() => Promise.resolve()) };
}

function createFixture() {
  const process = processDouble();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: vi.fn(() => Promise.resolve()),
    start: vi.fn(),
  } satisfies TelemetryLifecycle;
  const ledger = { close: vi.fn() };
  const artifacts = { close: vi.fn() };
  const databaseRuntime = closable();
  const database = closable();
  const enforcement = closable();
  const preview = closable();
  const runArtifacts = closable();
  const workspacePurge = closable();
  const metrics = Object.freeze({ kind: 'retention-metrics' });
  const createStructuredLogger = vi.fn(() => logger);
  const createDualRegionControlLedger = vi.fn(() => ledger);
  const createDualRegionArtifactStore = vi.fn(() => artifacts);
  const createDatabaseRuntime = vi.fn(() => databaseRuntime);
  const createRetentionDatabase = vi.fn(() => database);
  const createRetentionEnforcementCoordinator = vi.fn(() => enforcement);
  const createPreviewRetentionCoordinator = vi.fn(() => preview);
  const createRunArtifactRetentionCoordinator = vi.fn(() => runArtifacts);
  const createWorkspacePurgeCoordinator = vi.fn(() => workspacePurge);
  const runRetentionWorker = vi.fn(
    (
      _resources: Parameters<
        RetentionBootstrapModules['worker']['runRetentionWorker']
      >[0],
    ) => {
      void _resources;
      return Promise.resolve();
    },
  );
  const createMetrics = vi.fn(() => metrics);
  const modules = {
    artifactStore: {
      createDualRegionArtifactStore,
      createDualRegionControlLedger,
    },
    database: {
      createDatabaseRuntime,
      createPreviewRetentionCoordinator,
      createRetentionDatabase,
      createRetentionEnforcementCoordinator,
      createRunArtifactRetentionCoordinator,
      createWorkspacePurgeCoordinator,
    },
    logging: { createStructuredLogger },
    worker: { runRetentionWorker },
  } as unknown as RetentionBootstrapModules;
  const loadModules = vi.fn(() => Promise.resolve(modules));
  return {
    artifacts,
    createDatabaseRuntime,
    createDualRegionArtifactStore,
    createDualRegionControlLedger,
    createMetrics,
    createPreviewRetentionCoordinator,
    createRetentionDatabase,
    createRetentionEnforcementCoordinator,
    createRunArtifactRetentionCoordinator,
    createStructuredLogger,
    createWorkspacePurgeCoordinator,
    database,
    databaseRuntime,
    enforcement,
    ledger,
    loadModules,
    logger,
    metrics,
    preview,
    process,
    runArtifacts,
    runRetentionWorker,
    telemetry,
    workspacePurge,
  };
}

const acquisitionOrder = [
  'logger',
  'ledger',
  'artifacts',
  'databaseRuntime',
  'database',
  'enforcement',
  'preview',
  'runArtifacts',
  'workspacePurge',
  'metrics',
] as const;

describe('retention main bootstrap', () => {
  it('constructs every dependency and metric before worker ownership handoff', async () => {
    const fixture = createFixture();

    await expect(
      bootstrapRetention({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.runRetentionWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: fixture.artifacts,
        database: fixture.database,
        databaseRuntime: fixture.databaseRuntime,
        enforcement: fixture.enforcement,
        ledger: fixture.ledger,
        logger: fixture.logger,
        preview: fixture.preview,
        runArtifacts: fixture.runArtifacts,
        telemetry: fixture.telemetry,
        workspacePurge: fixture.workspacePurge,
      }),
    );
    const workerInput = fixture.runRetentionWorker.mock.calls[0]?.[0];
    expect(typeof workerInput?.metrics.record).toBe('function');
    expect(workerInput?.signal).toBeInstanceOf(AbortSignal);
    for (const owner of [
      fixture.enforcement,
      fixture.preview,
      fixture.runArtifacts,
      fixture.workspacePurge,
      fixture.database,
      fixture.databaseRuntime,
      fixture.artifacts,
      fixture.ledger,
    ]) {
      expect(owner.close).not.toHaveBeenCalled();
    }
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
  });

  it.each(['telemetry', 'modules', ...acquisitionOrder] as const)(
    'preserves a %s failure and closes every previously acquired owner once',
    async (boundary) => {
      const fixture = createFixture();
      const failure = new Error(`${boundary} failed`);
      if (boundary === 'telemetry') {
        fixture.telemetry.start.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'modules') {
        fixture.loadModules.mockRejectedValueOnce(failure);
      } else {
        const factories = {
          artifacts: fixture.createDualRegionArtifactStore,
          database: fixture.createRetentionDatabase,
          databaseRuntime: fixture.createDatabaseRuntime,
          enforcement: fixture.createRetentionEnforcementCoordinator,
          ledger: fixture.createDualRegionControlLedger,
          logger: fixture.createStructuredLogger,
          metrics: fixture.createMetrics,
          preview: fixture.createPreviewRetentionCoordinator,
          runArtifacts: fixture.createRunArtifactRetentionCoordinator,
          workspacePurge: fixture.createWorkspacePurgeCoordinator,
        };
        factories[boundary].mockImplementationOnce(() => {
          throw failure;
        });
      }

      await expect(
        bootstrapRetention({
          config,
          createMetrics: fixture.createMetrics as never,
          createTelemetryLifecycle: () => fixture.telemetry,
          loadModules: fixture.loadModules,
          process: fixture.process,
        }),
      ).rejects.toBe(failure);

      const boundaryIndex = acquisitionOrder.indexOf(
        boundary as (typeof acquisitionOrder)[number],
      );
      const wasAcquired = (name: (typeof acquisitionOrder)[number]) =>
        boundaryIndex > acquisitionOrder.indexOf(name);
      expect(fixture.enforcement.close).toHaveBeenCalledTimes(
        wasAcquired('enforcement') ? 1 : 0,
      );
      expect(fixture.preview.close).toHaveBeenCalledTimes(
        wasAcquired('preview') ? 1 : 0,
      );
      expect(fixture.runArtifacts.close).toHaveBeenCalledTimes(
        wasAcquired('runArtifacts') ? 1 : 0,
      );
      expect(fixture.workspacePurge.close).toHaveBeenCalledTimes(
        wasAcquired('workspacePurge') ? 1 : 0,
      );
      expect(fixture.database.close).toHaveBeenCalledTimes(
        wasAcquired('database') ? 1 : 0,
      );
      expect(fixture.databaseRuntime.close).toHaveBeenCalledTimes(
        wasAcquired('databaseRuntime') ? 1 : 0,
      );
      expect(fixture.artifacts.close).toHaveBeenCalledTimes(
        wasAcquired('artifacts') ? 1 : 0,
      );
      expect(fixture.ledger.close).toHaveBeenCalledTimes(
        wasAcquired('ledger') ? 1 : 0,
      );
      expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
      expect(fixture.runRetentionWorker).not.toHaveBeenCalled();
      expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
    },
  );

  it('contains fatal, synchronous close, asynchronous close, and cleanup-log failures', async () => {
    const fixture = createFixture();
    const failure = new Error('metrics failed');
    fixture.createMetrics.mockImplementationOnce(() => {
      throw failure;
    });
    fixture.logger.fatal.mockImplementationOnce(() => {
      throw new Error('fatal failed');
    });
    for (const owner of [
      fixture.enforcement,
      fixture.preview,
      fixture.runArtifacts,
      fixture.workspacePurge,
      fixture.database,
      fixture.databaseRuntime,
    ]) {
      owner.close.mockRejectedValueOnce(new Error('async close failed'));
    }
    fixture.artifacts.close.mockImplementationOnce(() => {
      throw new Error('artifact close failed');
    });
    fixture.ledger.close.mockImplementationOnce(() => {
      throw new Error('ledger close failed');
    });
    fixture.telemetry.shutdown.mockRejectedValueOnce(
      new Error('telemetry close failed'),
    );
    fixture.logger.error.mockImplementation(() => {
      throw new Error('cleanup logger failed');
    });

    await expect(
      bootstrapRetention({
        config,
        createMetrics: fixture.createMetrics as never,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).rejects.toBe(failure);

    for (const owner of [
      fixture.enforcement,
      fixture.preview,
      fixture.runArtifacts,
      fixture.workspacePurge,
      fixture.database,
      fixture.databaseRuntime,
      fixture.artifacts,
      fixture.ledger,
    ]) {
      expect(owner.close).toHaveBeenCalledOnce();
    }
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    expect(fixture.logger.error).toHaveBeenCalledTimes(9);
    expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
  });

  it('leaves cleanup to an invoked worker even when it rejects', async () => {
    const fixture = createFixture();
    const failure = new Error('worker failed');
    fixture.runRetentionWorker.mockRejectedValueOnce(failure);

    await expect(
      bootstrapRetention({
        config,
        createMetrics: fixture.createMetrics as never,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).rejects.toBe(failure);

    expect(fixture.enforcement.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s through the worker-owned signal and removes listeners',
    async (signalName) => {
      const fixture = createFixture();
      const entered = Promise.withResolvers<AbortSignal>();
      fixture.runRetentionWorker.mockImplementationOnce(({ signal }) => {
        entered.resolve(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('Retention test signal was aborted', {
                      cause: signal.reason,
                    }),
              );
            },
            { once: true },
          );
        });
      });
      const running = bootstrapRetention({
        config,
        createMetrics: fixture.createMetrics as never,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      });
      await entered.promise;
      fixture.process.emit(signalName);

      await expect(running).rejects.toMatchObject({
        message: 'Retention worker interrupted',
      });
      expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
      expect(fixture.enforcement.close).not.toHaveBeenCalled();
    },
  );
});
