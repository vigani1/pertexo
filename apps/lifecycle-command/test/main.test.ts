import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { WorkspaceLifecycleCommandCoordinator } from '@pertexo/database/lifecycle';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { MaintenanceMetrics } from '@pertexo/observability';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { parseLifecycleCommandConfig } from '../src/config.js';
import {
  bootstrapLifecycleCommand,
  type LifecycleCommandBootstrapModules,
} from '../src/main.js';

const config = parseLifecycleCommandConfig({
  CONTROL_LEDGER_ACCESS_KEY_ID: 'primary-key',
  CONTROL_LEDGER_BUCKET: 'pertexo-control-primary',
  CONTROL_LEDGER_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  CONTROL_LEDGER_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: 'recovery-key',
  CONTROL_LEDGER_RECOVERY_BUCKET: 'pertexo-control-recovery',
  CONTROL_LEDGER_RECOVERY_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_RECOVERY_REGION: 'eu-west-1',
  CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
  CONTROL_LEDGER_REGION: 'eu-central-1',
  CONTROL_LEDGER_SECRET_ACCESS_KEY: 'primary-secret',
  DATABASE_LIFECYCLE_COMMAND_URL:
    'postgresql://lifecycle:secret@localhost:5432/pertexo',
  LIFECYCLE_COMMAND_LEASE_OWNER: 'lifecycle:test-1',
});

function processDouble() {
  const listeners = new Map<string, () => void>();
  return {
    emit(signal: 'SIGINT' | 'SIGTERM'): void {
      listeners.get(signal)?.();
    },
    once: vi.fn((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      listeners.set(signal, listener);
    }),
    removeListener: vi.fn(
      (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    ),
  };
}

function modules(
  overrides: {
    readonly coordinator?: WorkspaceLifecycleCommandCoordinator;
    readonly ledger?: DualRegionControlLedger;
    readonly logger?: StructuredLogger;
    readonly runWorker?: () => Promise<void>;
  } = {},
): LifecycleCommandBootstrapModules {
  const ledger =
    overrides.ledger ??
    ({
      append: vi.fn(),
      checkReadiness: vi.fn(),
      close: vi.fn(),
      read: vi.fn(),
      reconcile: vi.fn(),
    } satisfies DualRegionControlLedger);
  const coordinator =
    overrides.coordinator ??
    ({
      checkReadiness: vi.fn(),
      close: vi.fn(),
      processNext: vi.fn(),
    } satisfies WorkspaceLifecycleCommandCoordinator);
  const logger =
    overrides.logger ??
    ({
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    } satisfies StructuredLogger);
  const metrics = {
    recordControlLedgerReconciliation: vi.fn(),
    recordLifecycleCommand: vi.fn(),
  } satisfies MaintenanceMetrics;

  return {
    artifactStore: {
      createDualRegionControlLedger: vi.fn(() => ledger),
    },
    database: {
      createWorkspaceLifecycleCommandCoordinator: vi.fn(() => coordinator),
    },
    logging: {
      createStructuredLogger: vi.fn(() => logger),
    },
    observability: {
      createMaintenanceMetrics: vi.fn(() => metrics),
    },
    worker: {
      runLifecycleCommandWorker:
        overrides.runWorker ?? (() => Promise.resolve()),
    },
  };
}

function telemetryDouble() {
  return {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: vi.fn(() => Promise.resolve()),
    start: vi.fn(),
  } satisfies TelemetryLifecycle;
}

describe('lifecycle command bootstrap', () => {
  it('composes dependencies, invokes the worker, and removes signal handlers', async () => {
    const process = processDouble();
    const telemetry = telemetryDouble();
    const readiness = {
      clear: vi.fn(() => Promise.resolve()),
      mark: vi.fn(() => Promise.resolve()),
    };
    const runWorker = vi.fn(() => Promise.resolve());

    await expect(
      bootstrapLifecycleCommand({
        config,
        createReadinessMarker: () => readiness,
        createTelemetryLifecycle: () => telemetry,
        loadModules: () => Promise.resolve(modules({ runWorker })),
        process,
      }),
    ).resolves.toBeUndefined();

    expect(telemetry.start).toHaveBeenCalledOnce();
    expect(runWorker).toHaveBeenCalledOnce();
    expect(process.once).toHaveBeenCalledTimes(2);
    expect(process.removeListener).toHaveBeenCalledTimes(2);
    expect(readiness.clear).not.toHaveBeenCalled();
    expect(telemetry.shutdown).not.toHaveBeenCalled();
  });

  it('cleans partially constructed resources when dependency construction fails', async () => {
    const process = processDouble();
    const telemetry = telemetryDouble();
    const readiness = {
      clear: vi.fn(() => Promise.resolve()),
      mark: vi.fn(() => Promise.resolve()),
    };
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    } satisfies StructuredLogger;
    const ledger = {
      append: vi.fn(),
      checkReadiness: vi.fn(),
      close: vi.fn(),
      read: vi.fn(),
      reconcile: vi.fn(),
    } satisfies DualRegionControlLedger;
    const constructionError = new Error('coordinator construction failed');
    const loaded = modules({ ledger, logger });
    loaded.database.createWorkspaceLifecycleCommandCoordinator = vi.fn(() => {
      throw constructionError;
    });

    await expect(
      bootstrapLifecycleCommand({
        config,
        createReadinessMarker: () => readiness,
        createTelemetryLifecycle: () => telemetry,
        loadModules: () => Promise.resolve(loaded),
        process,
      }),
    ).rejects.toBe(constructionError);

    expect(logger.fatal).toHaveBeenCalledWith(
      'lifecycle_command.bootstrap_failed',
      { errorType: 'Error' },
      constructionError,
    );
    expect(readiness.clear).toHaveBeenCalledOnce();
    expect(ledger.close).toHaveBeenCalledOnce();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
    expect(process.removeListener).toHaveBeenCalledTimes(2);
  });

  it('cleans telemetry and removes handlers when dependency loading fails', async () => {
    const process = processDouble();
    const telemetry = telemetryDouble();
    const readiness = {
      clear: vi.fn(() => Promise.resolve()),
      mark: vi.fn(() => Promise.resolve()),
    };
    const loadError = new Error('dependency import failed');

    await expect(
      bootstrapLifecycleCommand({
        config,
        createReadinessMarker: () => readiness,
        createTelemetryLifecycle: () => telemetry,
        loadModules: () => Promise.reject(loadError),
        process,
      }),
    ).rejects.toBe(loadError);

    expect(readiness.clear).toHaveBeenCalledOnce();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
    expect(process.removeListener).toHaveBeenCalledTimes(2);
  });
});
