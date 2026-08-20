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
import {
  createApiIdentityRuntime,
  type ApiIdentityRuntime,
  type ApiIdentityRuntimeOverrides,
} from './platform/identity/identity-runtime.module.js';

export type ApiApplicationDependencies = Readonly<{
  database?: WorkspaceDatabase;
  identityRuntime?: ApiIdentityRuntime;
  identityOverrides?: ApiIdentityRuntimeOverrides;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

export async function createApiApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<NestFastifyApplication> {
  const nestLogger = new NestLoggerAdapter(dependencies.logger);
  const identityRuntime =
    dependencies.identityRuntime ??
    (config.identity === undefined
      ? undefined
      : createApiIdentityRuntime(
          config.identity,
          config.database,
          dependencies.identityOverrides,
        ));
  let application: NestFastifyApplication;
  try {
    application = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, {
        ...dependencies,
        ...(identityRuntime === undefined ? {} : { identityRuntime }),
      }),
      new FastifyAdapter(),
      { abortOnError: false, logger: nestLogger },
    );
  } catch (error: unknown) {
    await identityRuntime?.close().catch(() => undefined);
    throw error;
  }

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
