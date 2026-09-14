import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { parseRecoveryConfig } from '../src/config.js';
import {
  bootstrapRecovery,
  type RecoveryBootstrapModules,
} from '../src/main.js';

const config = parseRecoveryConfig({
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
  const coordinator = { close: vi.fn(() => Promise.resolve()) };
  const metrics = { recordControlLedgerReconciliation: vi.fn() };
  const createStructuredLogger = vi.fn(() => logger);
  const createDualRegionControlLedger = vi.fn(() => ledger);
  const createDualRegionArtifactStore = vi.fn(() => artifacts);
  const createControlLedgerCoordinator = vi.fn(() => coordinator);
  const createMaintenanceMetrics = vi.fn(() => metrics);
  const restoreBeforeServe = vi.fn(
    (
      _resources: Parameters<
        RecoveryBootstrapModules['recovery']['restoreBeforeServe']
      >[0],
    ) => {
      void _resources;
      return Promise.resolve({} as never);
    },
  );
  const modules = {
    artifactStore: {
      createDualRegionArtifactStore,
      createDualRegionControlLedger,
    },
    database: { createControlLedgerCoordinator },
    logging: { createStructuredLogger },
    observability: { createMaintenanceMetrics },
    recovery: { restoreBeforeServe },
  } as unknown as RecoveryBootstrapModules;
  const loadModules = vi.fn(() => Promise.resolve(modules));
  return {
    artifacts,
    coordinator,
    createControlLedgerCoordinator,
    createDualRegionArtifactStore,
    createDualRegionControlLedger,
    createMaintenanceMetrics,
    createStructuredLogger,
    ledger,
    loadModules,
    logger,
    metrics,
    process,
    restoreBeforeServe,
    telemetry,
  };
}

describe('recovery main bootstrap', () => {
  it('constructs the complete restore input before transferring ownership', async () => {
    const fixture = createFixture();

    await expect(
      bootstrapRecovery({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.restoreBeforeServe).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactPageSize: config.coordinator.artifactPageSize,
        artifacts: fixture.artifacts,
        coordinator: fixture.coordinator,
        ledger: fixture.ledger,
        logger: fixture.logger,
        maxArtifactPages: config.coordinator.maxArtifactPages,
        metrics: fixture.metrics,
        telemetry: fixture.telemetry,
      }),
    );
    expect(fixture.restoreBeforeServe.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fixture.coordinator.close).not.toHaveBeenCalled();
    expect(fixture.ledger.close).not.toHaveBeenCalled();
    expect(fixture.artifacts.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
  });

  it.each([
    'telemetry',
    'modules',
    'logger',
    'ledger',
    'artifacts',
    'coordinator',
    'metrics',
  ] as const)(
    'preserves a %s failure and closes exactly the owners acquired before handoff',
    async (boundary) => {
      const fixture = createFixture();
      const failure = new Error(`${boundary} failed`);
      if (boundary === 'telemetry') {
        fixture.telemetry.start.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'modules') {
        fixture.loadModules.mockRejectedValueOnce(failure);
      } else if (boundary === 'logger') {
        fixture.createStructuredLogger.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'ledger') {
        fixture.createDualRegionControlLedger.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'artifacts') {
        fixture.createDualRegionArtifactStore.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'coordinator') {
        fixture.createControlLedgerCoordinator.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        fixture.createMaintenanceMetrics.mockImplementationOnce(() => {
          throw failure;
        });
      }

      await expect(
        bootstrapRecovery({
          config,
          createTelemetryLifecycle: () => fixture.telemetry,
          loadModules: fixture.loadModules,
          process: fixture.process,
        }),
      ).rejects.toBe(failure);

      const ledgerAcquired = ['artifacts', 'coordinator', 'metrics'].includes(
        boundary,
      );
      const artifactsAcquired = ['coordinator', 'metrics'].includes(boundary);
      const coordinatorAcquired = boundary === 'metrics';
      expect(fixture.coordinator.close).toHaveBeenCalledTimes(
        coordinatorAcquired ? 1 : 0,
      );
      expect(fixture.ledger.close).toHaveBeenCalledTimes(
        ledgerAcquired ? 1 : 0,
      );
      expect(fixture.artifacts.close).toHaveBeenCalledTimes(
        artifactsAcquired ? 1 : 0,
      );
      expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
      expect(fixture.restoreBeforeServe).not.toHaveBeenCalled();
      expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
    },
  );

  it('leaves cleanup to restore after the complete argument handoff', async () => {
    const fixture = createFixture();
    const failure = new Error('restore failed');
    fixture.restoreBeforeServe.mockRejectedValueOnce(failure);

    await expect(
      bootstrapRecovery({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).rejects.toBe(failure);

    expect(fixture.coordinator.close).not.toHaveBeenCalled();
    expect(fixture.ledger.close).not.toHaveBeenCalled();
    expect(fixture.artifacts.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
  });

  it('contains fatal and cleanup failures and still attempts every acquired owner', async () => {
    const fixture = createFixture();
    const failure = new Error('metrics failed');
    fixture.createMaintenanceMetrics.mockImplementationOnce(() => {
      throw failure;
    });
    fixture.logger.fatal.mockImplementationOnce(() => {
      throw new Error('fatal failed');
    });
    fixture.coordinator.close.mockRejectedValueOnce(new Error('close failed'));
    fixture.ledger.close.mockImplementationOnce(() => {
      throw new Error('ledger close failed');
    });
    fixture.artifacts.close.mockImplementationOnce(() => {
      throw new Error('artifact close failed');
    });
    fixture.telemetry.shutdown.mockRejectedValueOnce(
      new Error('telemetry close failed'),
    );

    await expect(
      bootstrapRecovery({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).rejects.toBe(failure);

    expect(fixture.coordinator.close).toHaveBeenCalledOnce();
    expect(fixture.ledger.close).toHaveBeenCalledOnce();
    expect(fixture.artifacts.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to the invoked restore signal and removes listeners',
    async (signalName) => {
      const fixture = createFixture();
      const entered = Promise.withResolvers<AbortSignal>();
      fixture.restoreBeforeServe.mockImplementationOnce(({ signal }) => {
        entered.resolve(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('Recovery test signal was aborted', {
                      cause: signal.reason,
                    }),
              );
            },
            { once: true },
          );
        });
      });
      const running = bootstrapRecovery({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      });
      await entered.promise;
      fixture.process.emit(signalName);

      await expect(running).rejects.toMatchObject({
        message: 'Restore recovery interrupted',
      });
      expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
      expect(fixture.coordinator.close).not.toHaveBeenCalled();
    },
  );
});
