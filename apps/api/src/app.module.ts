import 'reflect-metadata';

import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { DatabaseRuntime, WorkspaceDatabase } from '@pertexo/database/api';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { ApiConfig } from './platform/config/api-config.js';
import { CatalogModule } from './catalog/index.js';

import {
  DatabaseModule,
  WORKSPACE_DATABASE,
} from './platform/database/database.module.js';
import { LiveController } from './platform/health/live.controller.js';
import {
  API_RUNTIME_READINESS,
  ReadyController,
} from './platform/health/ready.controller.js';
import {
  ApiLifecycleModule,
  ApiShutdownCoordinator,
} from './platform/health/drain-state.js';
import { HttpPlatformModule } from './platform/http/http.module.js';
import type {
  HttpErrorLogEntry,
  HttpErrorLogger,
} from './platform/http/problem-details.filter.js';
import { ObservabilityModule } from './platform/observability/observability.module.js';
import {
  ConnectionRuntimeModule,
  type ApiConnectionRuntime,
} from './platform/connections/connection-runtime.module.js';
import {
  IdentityRuntimeModule,
  type ApiIdentityRuntime,
} from './platform/identity/identity-runtime.module.js';
import {
  WorkflowRuntimeModule,
  type ApiWorkflowRuntime,
} from './platform/workflow/workflow-runtime.module.js';
import type { ApiWebhookRuntime } from './platform/webhooks/webhook-runtime.module.js';
import { WebhookModule } from './webhooks/module.js';
import type { ApiScheduleRuntime } from './platform/schedules/schedule-runtime.module.js';
import { ScheduleModule } from './schedules/module.js';
import type { RateLimitConsumer } from './platform/rate-limit/interceptor.js';
import { RateLimitModule } from './platform/rate-limit/rate-limit.module.js';
import { APPLICATION_ERROR_MAPPERS } from './application-error-mappers.js';
import {
  ArtifactRuntimeModule,
  DEFAULT_ARTIFACT_MAX_OBJECT_BYTES,
  type ApiArtifactRuntime,
} from './platform/artifacts/artifact-runtime.module.js';

export type ApiModuleDependencies = Readonly<{
  database?: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime;
  identityRuntime?: ApiIdentityRuntime;
  connectionRuntime?: ApiConnectionRuntime;
  workflowRuntime?: ApiWorkflowRuntime;
  webhookRuntime?: ApiWebhookRuntime;
  scheduleRuntime?: ApiScheduleRuntime;
  artifactRuntime?: ApiArtifactRuntime;
  rateLimitConsumer?: RateLimitConsumer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

@Module({
  controllers: [LiveController, ReadyController],
  imports: [ApiLifecycleModule],
})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {
  public static register(
    config: ApiConfig,
    dependencies: ApiModuleDependencies,
  ): DynamicModule {
    const databaseOptions =
      dependencies.database === undefined
        ? {
            releaseCohort: config.nodeCompatibilityCohort,
            ...(dependencies.databaseRuntime === undefined
              ? {}
              : { runtime: dependencies.databaseRuntime }),
          }
        : {
            database: dependencies.database,
            releaseCohort: config.nodeCompatibilityCohort,
          };
    const httpErrorLogger: HttpErrorLogger = Object.freeze({
      log: (entry: HttpErrorLogEntry): void => {
        logHttpError(
          dependencies.logger,
          entry.severity,
          'http.request_failed',
          {
            code: entry.code,
            requestId: entry.requestId,
            ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }),
            ...(entry.workspaceId === undefined
              ? {}
              : { workspaceId: entry.workspaceId }),
            ...(entry.instance === undefined
              ? {}
              : { instance: entry.instance }),
          },
          entry.cause,
        );
      },
    });

    const identityModule =
      dependencies.identityRuntime === undefined
        ? undefined
        : IdentityRuntimeModule.register(dependencies.identityRuntime);
    const webhookRuntime = dependencies.webhookRuntime;
    const scheduleRuntime = dependencies.scheduleRuntime;
    const workflowRuntime = dependencies.workflowRuntime;
    const artifactRuntime = dependencies.artifactRuntime;
    const runtimeReadiness =
      workflowRuntime === undefined &&
      scheduleRuntime === undefined &&
      artifactRuntime === undefined
        ? undefined
        : {
            checkReadiness: async (): Promise<void> => {
              await Promise.all([
                workflowRuntime?.checkReadiness?.(),
                scheduleRuntime?.checkReadiness(),
                artifactRuntime?.checkReadiness(),
              ]);
            },
          };
    const featureModules = registerFeatureModules(
      config,
      dependencies,
      identityModule,
    );

    return {
      module: AppModule,
      imports: [
        ApiLifecycleModule,
        DatabaseModule.register(config.database, databaseOptions),
        ...featureModules,
        ObservabilityModule.register(
          dependencies.logger,
          dependencies.telemetry,
        ),
        HttpPlatformModule.register(httpErrorLogger, APPLICATION_ERROR_MAPPERS),
        RateLimitModule.register(
          config.redisUrl,
          dependencies.rateLimitConsumer,
        ),
      ],
      controllers: [LiveController, ReadyController],
      providers: [
        {
          provide: Symbol('API_RESOURCE_OWNERS'),
          inject: [ApiShutdownCoordinator, WORKSPACE_DATABASE],
          useFactory: (
            shutdown: ApiShutdownCoordinator,
            database: WorkspaceDatabase,
          ) => {
            if (dependencies.databaseRuntime !== undefined)
              shutdown.register('database-runtime', () =>
                dependencies.databaseRuntime?.close(),
              );
            shutdown.register('database', () => database.close());
            if (dependencies.identityRuntime !== undefined)
              shutdown.register('identity', () =>
                dependencies.identityRuntime?.close(),
              );
            if (workflowRuntime !== undefined)
              shutdown.register('workflow', () => workflowRuntime.close());
            if (dependencies.connectionRuntime !== undefined)
              shutdown.register('connection', () =>
                dependencies.connectionRuntime?.close(),
              );
            if (webhookRuntime !== undefined)
              shutdown.register('webhook', () => webhookRuntime.close());
            if (scheduleRuntime !== undefined)
              shutdown.register('schedule', () => scheduleRuntime.close());
            if (artifactRuntime !== undefined)
              shutdown.register('artifact', () => artifactRuntime.close());
            shutdown.register('telemetry', () =>
              dependencies.telemetry.shutdown(),
            );
            return Object.freeze({ registered: true });
          },
        },
        ...(runtimeReadiness === undefined
          ? []
          : [{ provide: API_RUNTIME_READINESS, useValue: runtimeReadiness }]),
      ],
    };
  }
}

function registerFeatureModules(
  config: ApiConfig,
  dependencies: ApiModuleDependencies,
  identityModule: DynamicModule | undefined,
): DynamicModule[] {
  if (identityModule === undefined) return [];
  const modules = [
    CatalogModule.register(
      { cohort: config.nodeCompatibilityCohort },
      identityModule,
    ),
  ];
  if (dependencies.workflowRuntime === undefined) modules.push(identityModule);
  else
    modules.push(
      WorkflowRuntimeModule.register(
        dependencies.workflowRuntime,
        identityModule,
      ),
    );

  if (dependencies.connectionRuntime !== undefined)
    modules.push(
      ConnectionRuntimeModule.register(
        dependencies.connectionRuntime,
        identityModule,
      ),
    );

  const authorization =
    dependencies.identityRuntime?.dependencies.authorization;
  if (authorization === undefined) return modules;
  if (dependencies.webhookRuntime !== undefined)
    modules.push(
      WebhookModule.register(
        dependencies.webhookRuntime.service,
        authorization,
        identityModule,
      ),
    );
  if (dependencies.scheduleRuntime !== undefined)
    modules.push(
      ScheduleModule.register(
        dependencies.scheduleRuntime.service,
        authorization,
        identityModule,
      ),
    );
  if (dependencies.artifactRuntime !== undefined)
    modules.push(
      ArtifactRuntimeModule.register(
        dependencies.artifactRuntime,
        identityModule,
        {
          maxObjectBytes:
            config.artifacts?.primary.maxObjectBytes ??
            DEFAULT_ARTIFACT_MAX_OBJECT_BYTES,
        },
      ),
    );
  return modules;
}

function logHttpError(
  logger: StructuredLogger,
  severity: HttpErrorLogEntry['severity'],
  event: string,
  fields: Readonly<Record<string, unknown>>,
  cause: unknown,
): void {
  if (severity === 'error') logger.error(event, fields, cause);
  else if (severity === 'warn') logger.warn(event, fields, cause);
  else logger.info(event, fields, cause);
}
