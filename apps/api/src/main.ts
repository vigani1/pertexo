import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import type { StructuredLogger } from '@pertexo/observability/logging';

import { parseApiConfig } from './platform/config/api-config.js';

interface CloseableApplication {
  close(): Promise<void>;
}

async function bootstrap(): Promise<void> {
  const config = parseApiConfig();
  const telemetry = createTelemetryLifecycle(config.observability);
  let logger: StructuredLogger | undefined;
  let application: CloseableApplication | undefined;

  try {
    telemetry.start();
    const [{ createStructuredLogger }, { createApiApplication }] =
      await Promise.all([
        import('@pertexo/observability/logging'),
        import('./app.js'),
      ]);
    logger = createStructuredLogger(config.observability);
    const createdApplication = await createApiApplication(config, {
      logger,
      telemetry,
    });
    application = createdApplication;
    await createdApplication.listen({ host: config.host, port: config.port });
    logger.info('api.started', { host: config.host, port: config.port });
  } catch (error: unknown) {
    if (logger === undefined) {
      try {
        const { createStructuredLogger } =
          await import('@pertexo/observability/logging');
        logger = createStructuredLogger(config.observability);
      } catch {
        // The process-level fallback below remains available if logging cannot load.
      }
    }
    logger?.fatal(
      'api.bootstrap_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      error,
    );
    try {
      await application?.close();
    } catch (closeError: unknown) {
      logger?.error('api.cleanup_failed', {}, closeError);
    }
    try {
      await telemetry.shutdown();
    } catch (shutdownError: unknown) {
      logger?.error('telemetry.shutdown_failed', {}, shutdownError);
    }
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'api.process_failed',
      errorType: error instanceof Error ? error.name : typeof error,
      level: 'fatal',
    })}\n`,
  );
  process.exitCode = 1;
});
