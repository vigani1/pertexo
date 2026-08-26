import type {
  ArtifactStore,
  DualRegionControlLedger,
  WorkspaceObjectPurgeStore,
} from '@pertexo/artifact-store';
import type {
  RetentionDatabase,
  RetentionEnforcementCoordinator,
  PreviewRetentionCoordinator,
  RunArtifactRetentionCoordinator,
  WorkspacePurgeCoordinator,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';

import { parseRetentionWorkerConfig } from './config.js';
import { createRetentionMetrics } from './metrics.js';

async function bootstrap(): Promise<void> {
  const config = parseRetentionWorkerConfig();
  const telemetry = createTelemetryLifecycle(config.observability);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('Retention worker interrupted'));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let database: RetentionDatabase | undefined;
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
    const [artifactStore, databasePackage, logging, worker] = await Promise.all(
      [
        import('@pertexo/artifact-store'),
        import('@pertexo/database'),
        import('@pertexo/observability/logging'),
        import('./run.js'),
      ],
    );
    logger = logging.createStructuredLogger(config.observability);
    ledger = artifactStore.createDualRegionControlLedger(
      config.ledger.primary,
      config.ledger.recovery,
    );
    artifacts = artifactStore.createArtifactStore(config.artifactStore);
    database = databasePackage.createRetentionDatabase(
      config.database,
      config.options,
    );
    enforcement = databasePackage.createRetentionEnforcementCoordinator(
      config.database,
      ledger,
      config.options,
    );
    preview = databasePackage.createPreviewRetentionCoordinator(
      config.database,
      ledger,
      artifacts,
      {
        artifactQuiescenceSeconds: Math.min(
          120,
          Math.ceil(config.artifactStore.requestTimeoutMs / 1_000) + 1,
        ),
        externalOperationTimeoutMs: config.options.externalOperationTimeoutMs,
        lockTimeoutMs: config.options.lockTimeoutMs,
        statementTimeoutMs: config.options.statementTimeoutMs,
      },
    );
    runArtifacts = databasePackage.createRunArtifactRetentionCoordinator(
      config.database,
      ledger,
      artifacts,
      {
        externalOperationTimeoutMs: config.options.externalOperationTimeoutMs,
        lockTimeoutMs: config.options.lockTimeoutMs,
        statementTimeoutMs: config.options.statementTimeoutMs,
      },
    );
    workspacePurge = databasePackage.createWorkspacePurgeCoordinator(
      config.database,
      ledger,
      artifacts,
      config.options,
    );
    workerInvoked = true;
    await worker.runRetentionWorker({
      artifacts,
      database,
      enforcement,
      expectedMaintenanceRole: config.expectedMaintenanceRole,
      logger,
      ledger,
      metrics: createRetentionMetrics(),
      pollIntervalMs: config.pollIntervalMs,
      preview,
      runArtifacts,
      workspacePurge,
      signal: shutdown.signal,
      telemetry,
    });
  } catch (error: unknown) {
    logger?.fatal(
      'retention.bootstrap_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      error,
    );
    if (!workerInvoked) {
      await enforcement?.close().catch(() => undefined);
      await preview?.close().catch(() => undefined);
      await runArtifacts?.close().catch(() => undefined);
      await workspacePurge?.close().catch(() => undefined);
      await database?.close().catch(() => undefined);
      artifacts?.close();
      ledger?.close();
      await telemetry.shutdown().catch(() => undefined);
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      errorType: error instanceof Error ? error.name : typeof error,
      event: 'retention.process_failed',
      level: 'fatal',
    })}\n`,
  );
  process.exitCode = 1;
});
