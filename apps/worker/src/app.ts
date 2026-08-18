import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { WorkspaceDatabase } from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { WorkerConfig } from './config/worker-config.js';
import { NestLoggerAdapter } from './platform/observability/observability.module.js';
import { WorkerReadiness } from './runtime/worker-readiness.js';
import { WorkerModule } from './worker.module.js';

export type WorkerApplicationDependencies = Readonly<{
  database?: WorkspaceDatabase;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

export async function createWorkerApplication(
  config: WorkerConfig,
  dependencies: WorkerApplicationDependencies,
): Promise<INestApplicationContext> {
  const application = await NestFactory.createApplicationContext(
    WorkerModule.register(config, dependencies),
    { abortOnError: false, logger: new NestLoggerAdapter(dependencies.logger) },
  );

  application.enableShutdownHooks();

  try {
    await application.get(WorkerReadiness).checkReadiness();
  } catch (error: unknown) {
    await application.close();
    throw error;
  }

  return application;
}
