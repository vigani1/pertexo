import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { ControlLedgerCoordinator } from '@pertexo/database';

import { parseRecoveryConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = parseRecoveryConfig();
  const telemetry = createTelemetryLifecycle(config.observability);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('Restore recovery interrupted'));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let logger: StructuredLogger | undefined;
  let coordinator: ControlLedgerCoordinator | undefined;
  let ledger: DualRegionControlLedger | undefined;
  let recoveryInvoked = false;
  try {
    telemetry.start();
    const [artifactStore, database, logging, recovery] = await Promise.all([
      import('@pertexo/artifact-store'),
      import('@pertexo/database'),
      import('@pertexo/observability/logging'),
      import('./restore-before-serve.js'),
    ]);
    logger = logging.createStructuredLogger(config.observability);
    ledger = artifactStore.createDualRegionControlLedger(
      config.ledger.primary,
      config.ledger.recovery,
    );
    coordinator = database.createControlLedgerCoordinator(
      config.database,
      ledger,
      config.coordinator,
    );
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(config.timeoutMs),
    ]);
    recoveryInvoked = true;
    await recovery.restoreBeforeServe({
      coordinator,
      expectedMaintenanceRole: config.maintenanceRole,
      ledger,
      logger,
      signal,
      telemetry,
    });
  } catch (error: unknown) {
    logger?.fatal(
      'restore_before_serve.bootstrap_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      error,
    );
    if (!recoveryInvoked) {
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
      event: 'restore_before_serve.process_failed',
      errorType: error instanceof Error ? error.name : typeof error,
      level: 'fatal',
    })}\n`,
  );
  process.exitCode = 1;
});
