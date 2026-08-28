import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { WorkspaceLifecycleCommandCoordinator } from '@pertexo/database/lifecycle';
import type { StructuredLogger } from '@pertexo/observability/logging';
import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';

import { parseLifecycleCommandConfig } from './config.js';
import { createLifecycleCommandReadinessMarker } from './readiness-marker.js';

async function bootstrap(): Promise<void> {
  const config = parseLifecycleCommandConfig();
  const telemetry = createTelemetryLifecycle(config.observability);
  const shutdown = new AbortController();
  const readiness = createLifecycleCommandReadinessMarker();
  const stop = (): void => {
    shutdown.abort(new Error('Lifecycle command worker interrupted'));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let coordinator: WorkspaceLifecycleCommandCoordinator | undefined;
  let ledger: DualRegionControlLedger | undefined;
  let logger: StructuredLogger | undefined;
  let workerInvoked = false;
  try {
    telemetry.start();
    const [artifactStore, database, observability, logging, worker] =
      await Promise.all([
        import('@pertexo/artifact-store'),
        import('@pertexo/database/lifecycle'),
        import('@pertexo/observability'),
        import('@pertexo/observability/logging'),
        import('./run.js'),
      ]);
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
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      errorType: error instanceof Error ? error.name : typeof error,
      event: 'lifecycle_command.process_failed',
      level: 'fatal',
    })}\n`,
  );
  process.exitCode = 1;
});
