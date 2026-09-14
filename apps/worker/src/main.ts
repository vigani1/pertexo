import { fileURLToPath } from 'node:url';

import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type * as LoggingModule from '@pertexo/observability/logging';

import type * as WorkerApplicationModule from './app.js';
import {
  parseWorkerConfig,
  type WorkerConfig,
} from './config/worker-config.js';
import { WorkerProcessShutdown } from './runtime/worker-process-shutdown.js';

interface CloseableApplication {
  close(signal?: string): Promise<void>;
}

interface WorkerShutdownOwner {
  close(): Promise<void>;
  install(): void;
}

export interface WorkerBootstrapModules {
  readonly application: Pick<
    typeof WorkerApplicationModule,
    'createWorkerApplication'
  >;
  readonly logging: Pick<typeof LoggingModule, 'createStructuredLogger'>;
}

export interface WorkerBootstrapDependencies {
  readonly config?: WorkerConfig;
  readonly createShutdownOwner?: (
    application: CloseableApplication,
    logger: StructuredLogger,
  ) => WorkerShutdownOwner;
  readonly createTelemetryLifecycle?: typeof createTelemetryLifecycle;
  readonly loadModules?: () => Promise<WorkerBootstrapModules>;
}

async function loadModules(): Promise<WorkerBootstrapModules> {
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

export async function bootstrapWorker(
  dependencies: WorkerBootstrapDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? parseWorkerConfig();
  const telemetry = (
    dependencies.createTelemetryLifecycle ?? createTelemetryLifecycle
  )(config.observability);
  let logger: StructuredLogger | undefined;
  let application: CloseableApplication | undefined;
  let shutdownOwner: WorkerShutdownOwner | undefined;
  let loadedLogging: WorkerBootstrapModules['logging'] | undefined;

  try {
    telemetry.start();
    const modules = await (dependencies.loadModules ?? loadModules)();
    loadedLogging = modules.logging;
    logger = modules.logging.createStructuredLogger(config.observability);
    application = await modules.application.createWorkerApplication(config, {
      logger,
      telemetry,
    });
    shutdownOwner = (
      dependencies.createShutdownOwner ??
      ((createdApplication, createdLogger) =>
        new WorkerProcessShutdown(createdApplication, createdLogger))
    )(application, logger);
    shutdownOwner.install();
    logger.info('worker.started');
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
        'worker.bootstrap_failed',
        { errorType: classifyProcessError(error) },
        error,
      ),
    );
    try {
      if (shutdownOwner === undefined) {
        await application?.close();
      } else {
        await shutdownOwner.close();
      }
    } catch (closeError: unknown) {
      reportDiagnostic(() =>
        logger?.error('worker.cleanup_failed', {}, closeError),
      );
    }
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
  void bootstrapWorker().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'worker.process_failed',
        errorType: classifyProcessError(error),
        level: 'fatal',
      })}\n`,
    );
    process.exitCode = 1;
  });
}
