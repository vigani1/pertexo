import { fileURLToPath } from 'node:url';

import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type * as LoggingModule from '@pertexo/observability/logging';
import type * as ObservabilityModule from '@pertexo/observability';
import type {
  DualRegionArtifactStore,
  DualRegionControlLedger,
} from '@pertexo/artifact-store';
import type * as ArtifactStoreModule from '@pertexo/artifact-store';
import type { ControlLedgerCoordinator } from '@pertexo/database/recovery';
import type * as RecoveryDatabaseModule from '@pertexo/database/recovery';

import type * as RestoreModule from './restore-before-serve.js';
import { parseRecoveryConfig, type RecoveryConfig } from './config.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface RecoveryProcess {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface RecoveryBootstrapModules {
  readonly artifactStore: Pick<
    typeof ArtifactStoreModule,
    'createDualRegionArtifactStore' | 'createDualRegionControlLedger'
  >;
  readonly database: Pick<
    typeof RecoveryDatabaseModule,
    'createControlLedgerCoordinator'
  >;
  readonly logging: Pick<typeof LoggingModule, 'createStructuredLogger'>;
  readonly observability: Pick<
    typeof ObservabilityModule,
    'createMaintenanceMetrics'
  >;
  readonly recovery: Pick<typeof RestoreModule, 'restoreBeforeServe'>;
}

export interface RecoveryBootstrapDependencies {
  readonly config?: RecoveryConfig;
  readonly createTelemetryLifecycle?: typeof createTelemetryLifecycle;
  readonly loadModules?: () => Promise<RecoveryBootstrapModules>;
  readonly process?: RecoveryProcess;
}

async function loadModules(): Promise<RecoveryBootstrapModules> {
  const [artifactStore, database, observability, logging, recovery] =
    await Promise.all([
      import('@pertexo/artifact-store'),
      import('@pertexo/database/recovery'),
      import('@pertexo/observability'),
      import('@pertexo/observability/logging'),
      import('./restore-before-serve.js'),
    ]);
  return { artifactStore, database, logging, observability, recovery };
}

function reportDiagnostic(report: (() => void) | undefined): void {
  try {
    report?.();
  } catch {
    // Process stderr remains the last-resort diagnostic owner.
  }
}

async function attemptBootstrapCleanup(
  close: (() => Promise<void> | void) | undefined,
): Promise<void> {
  try {
    await close?.();
  } catch {
    // The initiating bootstrap failure remains authoritative.
  }
}

export async function bootstrapRecovery(
  dependencies: RecoveryBootstrapDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? parseRecoveryConfig();
  const telemetry = (
    dependencies.createTelemetryLifecycle ?? createTelemetryLifecycle
  )(config.observability);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('Restore recovery interrupted'));
  };
  const processRuntime = dependencies.process ?? process;
  processRuntime.once('SIGINT', stop);
  processRuntime.once('SIGTERM', stop);
  let logger: StructuredLogger | undefined;
  let artifacts: DualRegionArtifactStore | undefined;
  let coordinator: ControlLedgerCoordinator | undefined;
  let ledger: DualRegionControlLedger | undefined;
  let recoveryInvoked = false;
  try {
    telemetry.start();
    const modules = await (dependencies.loadModules ?? loadModules)();
    logger = modules.logging.createStructuredLogger(config.observability);
    ledger = modules.artifactStore.createDualRegionControlLedger(
      config.ledger.primary,
      config.ledger.recovery,
    );
    artifacts = modules.artifactStore.createDualRegionArtifactStore(
      config.artifacts.primary,
      config.artifacts.recovery,
    );
    coordinator = modules.database.createControlLedgerCoordinator(
      config.database,
      ledger,
      config.coordinator,
    );
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(config.timeoutMs),
    ]);
    const recoveryResources = {
      artifactPageSize: config.coordinator.artifactPageSize,
      artifacts,
      coordinator,
      expectedMaintenanceRole: config.maintenanceRole,
      ledger,
      logger,
      metrics: modules.observability.createMaintenanceMetrics(),
      maxArtifactPages: config.coordinator.maxArtifactPages,
      signal,
      telemetry,
    };
    recoveryInvoked = true;
    await modules.recovery.restoreBeforeServe(recoveryResources);
  } catch (error: unknown) {
    reportDiagnostic(() =>
      logger?.fatal(
        'restore_before_serve.bootstrap_failed',
        { errorType: classifyProcessError(error) },
        error,
      ),
    );
    if (!recoveryInvoked) {
      await attemptBootstrapCleanup(() => coordinator?.close());
      await attemptBootstrapCleanup(() => ledger?.close());
      await attemptBootstrapCleanup(() => artifacts?.close());
      await attemptBootstrapCleanup(() => telemetry.shutdown());
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
  void bootstrapRecovery().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'restore_before_serve.process_failed',
        errorType: classifyProcessError(error),
        level: 'fatal',
      })}\n`,
    );
    process.exitCode = 1;
  });
}
