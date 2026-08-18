import type { WorkspaceDatabase } from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import type { ApiConfig } from './platform/config/api-config.js';
import { WORKSPACE_DATABASE } from './platform/database/database.module.js';
import { NestLoggerAdapter } from './platform/observability/observability.module.js';

export type ApiApplicationDependencies = Readonly<{
  database?: WorkspaceDatabase;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

export async function createApiApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<NestFastifyApplication> {
  const nestLogger = new NestLoggerAdapter(dependencies.logger);
  const application = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, dependencies),
    new FastifyAdapter(),
    { abortOnError: false, logger: nestLogger },
  );

  application.enableShutdownHooks();

  try {
    await application
      .get<WorkspaceDatabase>(WORKSPACE_DATABASE)
      .checkReadiness();
  } catch (error: unknown) {
    await application.close();
    throw error;
  }

  return application;
}
