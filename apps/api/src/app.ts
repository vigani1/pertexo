import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/api';
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
import type { RateLimitConsumer } from './platform/rate-limit/interceptor.js';

type ApiApplicationDependencyCore = Readonly<{
  database?: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime;
  webhookRuntime?: ApiWebhookRuntime;
  scheduleRuntime?: ApiScheduleRuntime;
  rateLimitConsumer?: RateLimitConsumer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

type IdentityRuntimeSource =
  | Readonly<{
      identityRuntime: ApiIdentityRuntime;
      identityOverrides?: never;
    }>
  | Readonly<{
      identityRuntime?: undefined;
      identityOverrides?: ApiIdentityRuntimeOverrides;
    }>;

type ConnectionRuntimeSource =
  | Readonly<{
      connectionRuntime: ApiConnectionRuntime;
      connectionOverrides?: never;
    }>
  | Readonly<{
      connectionRuntime?: undefined;
      connectionOverrides?: ApiConnectionRuntimeOverrides;
    }>;

type WorkflowRuntimeSource =
  | Readonly<{
      workflowRuntime: ApiWorkflowRuntime;
      workflowOverrides?: never;
    }>
  | Readonly<{
      workflowRuntime?: undefined;
      workflowOverrides?: ApiWorkflowRuntimeOverrides;
    }>;

export type ApiApplicationDependencies = ApiApplicationDependencyCore &
  IdentityRuntimeSource &
  ConnectionRuntimeSource &
  WorkflowRuntimeSource;

export async function createApiApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<NestFastifyApplication> {
  assertValidRuntimeSources(config, dependencies);
  const nestLogger = new NestLoggerAdapter(dependencies.logger);
  const databaseRuntime =
    dependencies.databaseRuntime ??
    (dependencies.database === undefined
      ? createDatabaseRuntime(config.database, { role: 'api' })
      : undefined);
  const identityRuntime =
    dependencies.identityRuntime ??
    (config.identity === undefined
      ? undefined
      : createApiIdentityRuntime(
          config.identity,
          config.database,
          dependencies.identityOverrides,
          databaseRuntime,
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
          databaseRuntime,
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
          databaseRuntime,
        ));
  const webhookRuntime =
    dependencies.webhookRuntime ??
    (identityRuntime === undefined || config.webhooks === undefined
      ? undefined
      : createApiWebhookRuntime(
          config.webhooks,
          config.database,
          config.nodeCompatibilityCohort,
          undefined,
          databaseRuntime,
        ));
  const scheduleRuntime =
    dependencies.scheduleRuntime ??
    (identityRuntime === undefined || dependencies.database !== undefined
      ? undefined
      : createApiScheduleRuntime(config.database, undefined, databaseRuntime));
  const fastifyAdapter = new FastifyAdapter({
    trustProxy:
      config.trustedProxyCidrs === undefined ||
      config.trustedProxyCidrs.length === 0
        ? false
        : [...config.trustedProxyCidrs],
  });
  let application: NestFastifyApplication;
  try {
    application = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(config, {
        logger: dependencies.logger,
        telemetry: dependencies.telemetry,
        ...(databaseRuntime === undefined ? {} : { databaseRuntime }),
        ...(dependencies.database === undefined
          ? {}
          : { database: dependencies.database }),
        ...(dependencies.rateLimitConsumer === undefined
          ? {}
          : { rateLimitConsumer: dependencies.rateLimitConsumer }),
        ...(identityRuntime === undefined ? {} : { identityRuntime }),
        ...(workflowRuntime === undefined ? {} : { workflowRuntime }),
        ...(connectionRuntime === undefined ? {} : { connectionRuntime }),
        ...(webhookRuntime === undefined ? {} : { webhookRuntime }),
        ...(scheduleRuntime === undefined ? {} : { scheduleRuntime }),
      }),
      fastifyAdapter,
      { abortOnError: false, logger: nestLogger },
    );
  } catch (error: unknown) {
    await Promise.allSettled([
      identityRuntime?.close(),
      workflowRuntime?.close(),
      connectionRuntime?.close(),
      webhookRuntime?.close(),
      scheduleRuntime?.close(),
      databaseRuntime?.close(),
    ]);
    throw error;
  }

  application.enableShutdownHooks();
  try {
    const fastifyInstance: FastifyInstance = fastifyAdapter.getInstance();
    registerApiMetrics(fastifyInstance);
    await application.init();
    if (webhookRuntime !== undefined) {
      registerWebhookIngress(fastifyInstance, webhookRuntime.ingress);
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

function assertValidRuntimeSources(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): void {
  const unchecked = dependencies as ApiApplicationDependencyCore & {
    identityRuntime?: ApiIdentityRuntime;
    identityOverrides?: ApiIdentityRuntimeOverrides;
    connectionRuntime?: ApiConnectionRuntime;
    connectionOverrides?: ApiConnectionRuntimeOverrides;
    workflowRuntime?: ApiWorkflowRuntime;
    workflowOverrides?: ApiWorkflowRuntimeOverrides;
  };
  assertExclusiveRuntime(
    'identity',
    unchecked.identityRuntime,
    unchecked.identityOverrides,
  );
  assertExclusiveRuntime(
    'connection',
    unchecked.connectionRuntime,
    unchecked.connectionOverrides,
  );
  assertExclusiveRuntime(
    'workflow',
    unchecked.workflowRuntime,
    unchecked.workflowOverrides,
  );

  const identityAvailable =
    unchecked.identityRuntime !== undefined || config.identity !== undefined;
  if (
    unchecked.identityOverrides !== undefined &&
    config.identity === undefined
  )
    throw new TypeError(
      'identity overrides require configured identity runtime creation',
    );
  if (
    unchecked.connectionOverrides !== undefined &&
    (config.connections === undefined || !identityAvailable)
  )
    throw new TypeError(
      'connection overrides require configured connection runtime creation',
    );
  if (unchecked.workflowOverrides !== undefined && !identityAvailable)
    throw new TypeError(
      'workflow overrides require available identity runtime creation',
    );
  if (
    !identityAvailable &&
    (unchecked.connectionRuntime !== undefined ||
      unchecked.workflowRuntime !== undefined ||
      unchecked.webhookRuntime !== undefined ||
      unchecked.scheduleRuntime !== undefined)
  )
    throw new TypeError(
      'feature runtimes require an available identity runtime',
    );
}

function assertExclusiveRuntime(
  feature: string,
  runtime: unknown,
  overrides: unknown,
): void {
  if (runtime !== undefined && overrides !== undefined)
    throw new TypeError(
      `${feature} runtime cannot be provided with ${feature} overrides`,
    );
}
