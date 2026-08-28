import type { WorkspaceDatabase } from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';

import { AppModule } from './app.module.js';
import type { ApiConfig } from './platform/config/api-config.js';
import { WORKSPACE_DATABASE } from './platform/database/database.module.js';
import { NestLoggerAdapter } from './platform/observability/observability.module.js';
import { registerApiMetrics } from './platform/observability/api-metrics.js';
import {
  createApiConnectionRuntime,
  type ApiConnectionRuntime,
  type ApiConnectionRuntimeOverrides,
} from './platform/connections/connection-runtime.module.js';
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
import {
  createApiWebhookRuntime,
  type ApiWebhookRuntime,
} from './platform/webhooks/webhook-runtime.module.js';
import { registerWebhookIngress } from './webhooks/ingress.js';
import {
  createApiScheduleRuntime,
  type ApiScheduleRuntime,
} from './platform/schedules/schedule-runtime.module.js';

export type ApiApplicationDependencies = Readonly<{
  database?: WorkspaceDatabase;
  identityRuntime?: ApiIdentityRuntime;
  identityOverrides?: ApiIdentityRuntimeOverrides;
  connectionRuntime?: ApiConnectionRuntime;
  connectionOverrides?: ApiConnectionRuntimeOverrides;
  workflowRuntime?: ApiWorkflowRuntime;
  workflowOverrides?: ApiWorkflowRuntimeOverrides;
  webhookRuntime?: ApiWebhookRuntime;
  scheduleRuntime?: ApiScheduleRuntime;
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
          {
            ...dependencies.workflowOverrides,
            releaseCohort: config.nodeCompatibilityCohort,
          },
        ));
  const connectionRuntime =
    dependencies.connectionRuntime ??
    (identityRuntime === undefined || config.connections === undefined
      ? undefined
      : createApiConnectionRuntime(
          config.connections,
          config.database,
          identityRuntime,
          dependencies.connectionOverrides,
        ));
  const webhookRuntime =
    dependencies.webhookRuntime ??
    (identityRuntime === undefined || config.webhooks === undefined
      ? undefined
      : createApiWebhookRuntime(
          config.webhooks,
          config.database,
          config.nodeCompatibilityCohort,
        ));
  const scheduleRuntime =
    dependencies.scheduleRuntime ??
    (identityRuntime === undefined || dependencies.database !== undefined
      ? undefined
      : createApiScheduleRuntime(config.database));
  let application: NestFastifyApplication;
  try {
    application = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, {
        ...dependencies,
        ...(identityRuntime === undefined ? {} : { identityRuntime }),
        ...(workflowRuntime === undefined ? {} : { workflowRuntime }),
        ...(connectionRuntime === undefined ? {} : { connectionRuntime }),
        ...(webhookRuntime === undefined ? {} : { webhookRuntime }),
        ...(scheduleRuntime === undefined ? {} : { scheduleRuntime }),
      }),
      new FastifyAdapter(),
      { abortOnError: false, logger: nestLogger },
    );
  } catch (error: unknown) {
    await Promise.allSettled([
      identityRuntime?.close(),
      workflowRuntime?.close(),
      connectionRuntime?.close(),
      webhookRuntime?.close(),
      scheduleRuntime?.close(),
    ]);
    throw error;
  }

  application.enableShutdownHooks();
  try {
    registerApiMetrics(
      application.getHttpAdapter().getInstance() as unknown as FastifyInstance,
    );
    await application.init();
    if (webhookRuntime !== undefined) {
      registerWebhookIngress(
        application
          .getHttpAdapter()
          .getInstance() as unknown as FastifyInstance,
        webhookRuntime.ingress,
      );
    }
    await application
      .get<WorkspaceDatabase>(WORKSPACE_DATABASE)
      .checkCompatibility();
    await scheduleRuntime?.checkReadiness();
  } catch (error: unknown) {
    await application.close();
    throw error;
  }

  return application;
}
