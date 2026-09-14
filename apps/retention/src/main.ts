import { fileURLToPath } from 'node:url';

import type {
  ArtifactStore,
  DualRegionControlLedger,
  WorkspaceObjectPurgeStore,
} from '@pertexo/artifact-store';
import type * as ArtifactStoreModule from '@pertexo/artifact-store';
import type {
  RetentionDatabase,
  RetentionEnforcementCoordinator,
  PreviewRetentionCoordinator,
  RunArtifactRetentionCoordinator,
  WorkspacePurgeCoordinator,
  DatabaseRuntime,
} from '@pertexo/database/maintenance';
import type * as MaintenanceDatabaseModule from '@pertexo/database/maintenance';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type * as LoggingModule from '@pertexo/observability/logging';
import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';

import type * as RetentionRunModule from './run.js';
import {
  parseRetentionWorkerConfig,
  type RetentionWorkerConfig,
} from './config.js';
import { createRetentionMetrics } from './metrics.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface RetentionProcess {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface RetentionBootstrapModules {
  readonly artifactStore: Pick<
    typeof ArtifactStoreModule,
    'createDualRegionArtifactStore' | 'createDualRegionControlLedger'
  >;
  readonly database: Pick<
    typeof MaintenanceDatabaseModule,
    | 'createDatabaseRuntime'
    | 'createPreviewRetentionCoordinator'
    | 'createRetentionDatabase'
    | 'createRetentionEnforcementCoordinator'
    | 'createRunArtifactRetentionCoordinator'
    | 'createWorkspacePurgeCoordinator'
  >;
  readonly logging: Pick<typeof LoggingModule, 'createStructuredLogger'>;
  readonly worker: Pick<typeof RetentionRunModule, 'runRetentionWorker'>;
}

export interface RetentionBootstrapDependencies {
  readonly config?: RetentionWorkerConfig;
  readonly createMetrics?: typeof createRetentionMetrics;
  readonly createTelemetryLifecycle?: typeof createTelemetryLifecycle;
  readonly loadModules?: () => Promise<RetentionBootstrapModules>;
  readonly process?: RetentionProcess;
}

async function loadModules(): Promise<RetentionBootstrapModules> {
  const [artifactStore, database, logging, worker] = await Promise.all([
    import('@pertexo/artifact-store'),
    import('@pertexo/database/maintenance'),
    import('@pertexo/observability/logging'),
    import('./run.js'),
  ]);
  return { artifactStore, database, logging, worker };
}

function reportDiagnostic(report: (() => void) | undefined): void {
  try {
    report?.();
  } catch {
    // Process stderr remains the last-resort diagnostic owner.
  }
}

async function attemptBootstrapCleanup(
  label: string,
  close: (() => Promise<void> | void) | undefined,
  logger: StructuredLogger | undefined,
): Promise<void> {
  if (close === undefined) return;
  try {
    await close();
  } catch (error: unknown) {
    reportDiagnostic(() =>
      logger?.error(
        'retention.cleanup_failed',
        { errorType: classifyProcessError(error), resource: label },
        error,
      ),
    );
  }
}

export async function bootstrapRetention(
  dependencies: RetentionBootstrapDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? parseRetentionWorkerConfig();
  const telemetry = (
    dependencies.createTelemetryLifecycle ?? createTelemetryLifecycle
  )(config.observability);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('Retention worker interrupted'));
  };
  const processRuntime = dependencies.process ?? process;
  processRuntime.once('SIGINT', stop);
  processRuntime.once('SIGTERM', stop);
  let database: RetentionDatabase | undefined;
  let databaseRuntime: DatabaseRuntime | undefined;
  let enforcement: RetentionEnforcementCoordinator | undefined;
  let ledger: DualRegionControlLedger | undefined;
  let logger: StructuredLogger | undefined;
  let preview: PreviewRetentionCoordinator | undefined;
  let runArtifacts: RunArtifactRetentionCoordinator | undefined;
  let workspacePurge: WorkspacePurgeCoordinator | undefined;
  let artifacts: (ArtifactStore & WorkspaceObjectPurgeStore) | undefined;
  let workerInvoked = false;
  try {
    telemetry.start();
    const modules = await (dependencies.loadModules ?? loadModules)();
    logger = modules.logging.createStructuredLogger(config.observability);
    ledger = modules.artifactStore.createDualRegionControlLedger(
      config.ledger.primary,
      config.ledger.recovery,
    );
    artifacts = modules.artifactStore.createDualRegionArtifactStore(
      config.artifactStore.primary,
      config.artifactStore.recovery,
    );
    databaseRuntime = modules.database.createDatabaseRuntime(config.database, {
      role: 'maintenance',
    });
    database = modules.database.createRetentionDatabase(
      config.database,
      {
        leaseOwner: config.options.leaseOwner,
        leaseSeconds: config.options.leaseSeconds,
        lockTimeoutMs: config.options.lockTimeoutMs,
        maxPagesPerBatch: config.options.maxPagesPerBatch,
        pageSize: config.options.pageSize,
        statementTimeoutMs: config.options.statementTimeoutMs,
      },
      databaseRuntime,
    );
    enforcement = modules.database.createRetentionEnforcementCoordinator(
      config.database,
      ledger,
      config.options,
      databaseRuntime,
    );
    preview = modules.database.createPreviewRetentionCoordinator(
      config.database,
      ledger,
      artifacts,
      {
        artifactQuiescenceSeconds: Math.min(
          120,
          Math.ceil(
            Math.max(
              config.artifactStore.primary.requestTimeoutMs,
              config.artifactStore.recovery.requestTimeoutMs,
            ) / 1_000,
          ) + 1,
        ),
        externalOperationTimeoutMs: config.options.externalOperationTimeoutMs,
        lockTimeoutMs: config.options.lockTimeoutMs,
        statementTimeoutMs: config.options.statementTimeoutMs,
      },
      databaseRuntime,
    );
    runArtifacts = modules.database.createRunArtifactRetentionCoordinator(
      config.database,
      ledger,
      artifacts,
      {
        externalOperationTimeoutMs: config.options.externalOperationTimeoutMs,
        lockTimeoutMs: config.options.lockTimeoutMs,
        statementTimeoutMs: config.options.statementTimeoutMs,
      },
      databaseRuntime,
    );
    workspacePurge = modules.database.createWorkspacePurgeCoordinator(
      config.database,
      ledger,
      artifacts,
      config.options,
      databaseRuntime,
    );
    const workerResources = {
      artifacts,
      database,
      databaseRuntime,
      enforcement,
      expectedMaintenanceRole: config.expectedMaintenanceRole,
      logger,
      ledger,
      metrics: (dependencies.createMetrics ?? createRetentionMetrics)(),
      pollIntervalMs: config.pollIntervalMs,
      replicaMonitor: config.replicaMonitor,
      preview,
      runArtifacts,
      workspacePurge,
      signal: shutdown.signal,
      telemetry,
    };
    workerInvoked = true;
    await modules.worker.runRetentionWorker(workerResources);
  } catch (error: unknown) {
    reportDiagnostic(() =>
      logger?.fatal(
        'retention.bootstrap_failed',
        { errorType: classifyProcessError(error) },
        error,
      ),
    );
    if (!workerInvoked) {
      await attemptBootstrapCleanup(
        'retention_enforcement',
        () => enforcement?.close(),
        logger,
      );
      await attemptBootstrapCleanup(
        'preview_retention',
        () => preview?.close(),
        logger,
      );
      await attemptBootstrapCleanup(
        'run_artifact_retention',
        () => runArtifacts?.close(),
        logger,
      );
      await attemptBootstrapCleanup(
        'workspace_purge',
        () => workspacePurge?.close(),
        logger,
      );
      await attemptBootstrapCleanup(
        'database',
        () => database?.close(),
        logger,
      );
      await attemptBootstrapCleanup(
        'database_runtime',
        () => databaseRuntime?.close(),
        logger,
      );
      await attemptBootstrapCleanup(
        'artifacts',
        () => artifacts?.close(),
        logger,
      );
      await attemptBootstrapCleanup('ledger', () => ledger?.close(), logger);
      await attemptBootstrapCleanup(
        'telemetry',
        () => telemetry.shutdown(),
        logger,
      );
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
  void bootstrapRetention().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        errorType: classifyProcessError(error),
        event: 'retention.process_failed',
        level: 'fatal',
      })}\n`,
    );
    process.exitCode = 1;
  });
}
