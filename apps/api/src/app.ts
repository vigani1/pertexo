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
import {
  createApiWorkflowRuntime,
  type ApiWorkflowRuntime,
  type ApiWorkflowRuntimeOverrides,
} from './platform/workflow/workflow-runtime.module.js';

export type ApiApplicationDependencies = Readonly<{
  database?: WorkspaceDatabase;
  identityRuntime?: ApiIdentityRuntime;
  identityOverrides?: ApiIdentityRuntimeOverrides;
  workflowRuntime?: ApiWorkflowRuntime;
  workflowOverrides?: ApiWorkflowRuntimeOverrides;
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
  const workflowRuntime =
    dependencies.workflowRuntime ??
    (identityRuntime === undefined
      ? undefined
      : createApiWorkflowRuntime(
          config.database,
          identityRuntime,
          config.redisUrl,
          dependencies.workflowOverrides,
        ));
  let application: NestFastifyApplication;
  try {
    application = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, {
        ...dependencies,
        ...(identityRuntime === undefined ? {} : { identityRuntime }),
        ...(workflowRuntime === undefined ? {} : { workflowRuntime }),
      }),
      new FastifyAdapter(),
      { abortOnError: false, logger: nestLogger },
    );
  } catch (error: unknown) {
    await Promise.allSettled([
      identityRuntime?.close(),
      workflowRuntime?.close(),
    ]);
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
