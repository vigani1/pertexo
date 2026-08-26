import type { RetentionDatabase } from '@pertexo/database';
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
  let logger: StructuredLogger | undefined;
  let workerInvoked = false;
  try {
    telemetry.start();
    const [databasePackage, logging, worker] = await Promise.all([
      import('@pertexo/database'),
      import('@pertexo/observability/logging'),
      import('./run.js'),
    ]);
    logger = logging.createStructuredLogger(config.observability);
    database = databasePackage.createRetentionDatabase(
      config.database,
      config.options,
    );
    workerInvoked = true;
    await worker.runRetentionWorker({
      database,
      expectedMaintenanceRole: config.expectedMaintenanceRole,
      logger,
      metrics: createRetentionMetrics(),
      pollIntervalMs: config.pollIntervalMs,
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
      await database?.close().catch(() => undefined);
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
