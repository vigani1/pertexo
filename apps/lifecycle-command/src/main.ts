import { fileURLToPath } from 'node:url';

import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type * as ArtifactStoreModule from '@pertexo/artifact-store';
import type { WorkspaceLifecycleCommandCoordinator } from '@pertexo/database/lifecycle';
import type * as DatabaseLifecycleModule from '@pertexo/database/lifecycle';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type * as LoggingModule from '@pertexo/observability/logging';
import type * as ObservabilityModule from '@pertexo/observability';
import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import type * as LifecycleRunModule from './run.js';

import {
  parseLifecycleCommandConfig,
  type LifecycleCommandConfig,
} from './config.js';
import { createLifecycleCommandReadinessMarker } from './readiness-marker.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface LifecycleCommandBootstrapModules {
  readonly artifactStore: Pick<
    typeof ArtifactStoreModule,
    'createDualRegionControlLedger'
  >;
  readonly database: Pick<
    typeof DatabaseLifecycleModule,
    'createWorkspaceLifecycleCommandCoordinator'
  >;
  readonly logging: Pick<typeof LoggingModule, 'createStructuredLogger'>;
  readonly observability: Pick<
    typeof ObservabilityModule,
    'createMaintenanceMetrics'
  >;
  readonly worker: Pick<typeof LifecycleRunModule, 'runLifecycleCommandWorker'>;
}

interface LifecycleCommandProcess {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface LifecycleCommandBootstrapDependencies {
  readonly config?: LifecycleCommandConfig;
  readonly createReadinessMarker?: typeof createLifecycleCommandReadinessMarker;
  readonly createTelemetryLifecycle?: typeof createTelemetryLifecycle;
  readonly loadModules?: () => Promise<LifecycleCommandBootstrapModules>;
  readonly process?: LifecycleCommandProcess;
}

async function loadModules(): Promise<LifecycleCommandBootstrapModules> {
  const [artifactStore, database, observability, logging, worker] =
    await Promise.all([
      import('@pertexo/artifact-store'),
      import('@pertexo/database/lifecycle'),
      import('@pertexo/observability'),
      import('@pertexo/observability/logging'),
      import('./run.js'),
    ]);
  return { artifactStore, database, logging, observability, worker };
}

export async function bootstrapLifecycleCommand(
  dependencies: LifecycleCommandBootstrapDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? parseLifecycleCommandConfig();
  const telemetry = (
    dependencies.createTelemetryLifecycle ?? createTelemetryLifecycle
  )(config.observability);
  const shutdown = new AbortController();
  const readiness = (
    dependencies.createReadinessMarker ?? createLifecycleCommandReadinessMarker
  )();
  const processRuntime = dependencies.process ?? process;
  const stop = (): void => {
    shutdown.abort(new Error('Lifecycle command worker interrupted'));
  };
  processRuntime.once('SIGINT', stop);
  processRuntime.once('SIGTERM', stop);
  let coordinator: WorkspaceLifecycleCommandCoordinator | undefined;
  let ledger: DualRegionControlLedger | undefined;
  let logger: StructuredLogger | undefined;
  let workerInvoked = false;
  try {
    telemetry.start();
    const { artifactStore, database, observability, logging, worker } = await (
      dependencies.loadModules ?? loadModules
    )();
    logger = logging.createStructuredLogger(config.observability);
    ledger = artifactStore.createDualRegionControlLedger(
      config.ledger.primary,
      config.ledger.recovery,
    );
    coordinator = database.createWorkspaceLifecycleCommandCoordinator(
      config.database,
      ledger,
      config.coordinator,
    );
    workerInvoked = true;
    await worker.runLifecycleCommandWorker({
      coordinator,
      expectedLifecycleCommandRole: config.lifecycleCommandRole,
      ledger,
      logger,
      metrics: observability.createMaintenanceMetrics(),
      pollIntervalMs: config.pollIntervalMs,
      readiness,
      signal: shutdown.signal,
      telemetry,
    });
  } catch (error: unknown) {
    logger?.fatal(
      'lifecycle_command.bootstrap_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      error,
    );
    if (!workerInvoked) {
      await readiness.clear().catch(() => undefined);
      await coordinator?.close().catch(() => undefined);
      try {
        ledger?.close();
      } catch {
        // The original bootstrap failure remains authoritative.
      }
      await telemetry.shutdown().catch(() => undefined);
    }
    throw error;
  } finally {
    processRuntime.removeListener('SIGINT', stop);
    processRuntime.removeListener('SIGTERM', stop);
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

if (isMainModule()) {
  void bootstrapLifecycleCommand().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        errorType: error instanceof Error ? error.name : typeof error,
        event: 'lifecycle_command.process_failed',
        level: 'fatal',
      })}\n`,
    );
    process.exitCode = 1;
  });
}
