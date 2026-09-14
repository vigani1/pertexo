import { fileURLToPath } from 'node:url';

import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type * as LoggingModule from '@pertexo/observability/logging';

import type * as ApiApplicationModule from './app.js';
import {
  parseApiConfig,
  type ApiConfig,
} from './platform/config/api-config.js';

interface CloseableApplication {
  close(): Promise<void>;
}

export interface ApiBootstrapModules {
  readonly application: Pick<
    typeof ApiApplicationModule,
    'createApiApplication'
  >;
  readonly logging: Pick<typeof LoggingModule, 'createStructuredLogger'>;
}

export interface ApiBootstrapDependencies {
  readonly config?: ApiConfig;
  readonly createTelemetryLifecycle?: typeof createTelemetryLifecycle;
  readonly loadModules?: () => Promise<ApiBootstrapModules>;
}

async function loadModules(): Promise<ApiBootstrapModules> {
  const [logging, application] = await Promise.all([
    import('@pertexo/observability/logging'),
    import('./app.js'),
  ]);
  return { application, logging };
}

function reportDiagnostic(report: (() => void) | undefined): void {
  try {
    report?.();
  } catch {
    // Process stderr remains the last-resort diagnostic owner.
  }
}

export async function bootstrapApi(
  dependencies: ApiBootstrapDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? parseApiConfig();
  const telemetry = (
    dependencies.createTelemetryLifecycle ?? createTelemetryLifecycle
  )(config.observability);
  let logger: StructuredLogger | undefined;
  let application: CloseableApplication | undefined;
  let loadedLogging: ApiBootstrapModules['logging'] | undefined;

  try {
    telemetry.start();
    const modules = await (dependencies.loadModules ?? loadModules)();
    loadedLogging = modules.logging;
    logger = modules.logging.createStructuredLogger(config.observability);
    const createdApplication = await modules.application.createApiApplication(
      config,
      {
        logger,
        telemetry,
      },
    );
    application = createdApplication;
    await createdApplication.listen({ host: config.host, port: config.port });
    logger.info('api.started', { host: config.host, port: config.port });
  } catch (error: unknown) {
    if (logger === undefined) {
      try {
        const logging =
          loadedLogging ??
          (dependencies.loadModules === undefined
            ? await import('@pertexo/observability/logging')
            : undefined);
        logger = logging?.createStructuredLogger(config.observability);
      } catch {
        // The process-level fallback below remains available if logging cannot load.
      }
    }
    reportDiagnostic(() =>
      logger?.fatal(
        'api.bootstrap_failed',
        { errorType: classifyProcessError(error) },
        error,
      ),
    );
    try {
      await application?.close();
    } catch (closeError: unknown) {
      reportDiagnostic(() =>
        logger?.error('api.cleanup_failed', {}, closeError),
      );
    }
    if (application === undefined)
      try {
        await telemetry.shutdown();
      } catch (shutdownError: unknown) {
        reportDiagnostic(() =>
          logger?.error('telemetry.shutdown_failed', {}, shutdownError),
        );
      }
    throw error;
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

if (isMainModule()) {
  void bootstrapApi().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'api.process_failed',
        errorType: classifyProcessError(error),
        level: 'fatal',
      })}\n`,
    );
    process.exitCode = 1;
  });
}
