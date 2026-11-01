import 'reflect-metadata';

import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { WorkspaceDatabase } from '@pertexo/database/platform';

import type { ApiRuntimeSet } from './platform/application/contract.js';
import type { ApiConfig } from './platform/config/api.js';
import { ConnectionsModule } from './connections/index.js';
import { CatalogModule } from './catalog/index.js';
import { ArtifactsModule } from './artifacts/index.js';

import {
  DatabaseModule,
  WORKSPACE_DATABASE,
} from './platform/database/module.js';
import { LiveController } from './platform/health/live.controller.js';
import {
  API_READINESS_LOGGER,
  API_RUNTIME_READINESS,
  ReadyController,
} from './platform/health/ready.controller.js';
import {
  ApiLifecycleModule,
  ApiShutdownCoordinator,
} from './platform/health/drain-state.js';
import { HttpPlatformModule } from './platform/http/module.js';
import type {
  HttpErrorLogEntry,
  HttpErrorLogger,
} from './platform/http/problem-details.filter.js';
import { ObservabilityModule } from './platform/observability/module.js';
import { ConnectionRuntimeModule } from './platform/connections/runtime.module.js';
import { IdentityRuntimeModule } from './platform/identity/runtime.module.js';
import { WorkflowRuntimeModule } from './platform/workflow/runtime.module.js';
import { WebhookModule } from './webhooks/module.js';
import { ScheduleModule } from './schedules/module.js';
import { NotificationsModule } from './notifications/module.js';
import { RateLimitModule } from './platform/rate-limit/module.js';
import { APPLICATION_ERROR_MAPPERS } from './application-errors.js';
import {
  ArtifactRuntimeModule,
  DEFAULT_ARTIFACT_MAX_OBJECT_BYTES,
} from './platform/artifacts/runtime.module.js';

export type ApiModuleDependencies = ApiRuntimeSet &
  Readonly<{
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
    const httpErrorLogger: HttpErrorLogger = Object.freeze({
      log: (entry: HttpErrorLogEntry): void => {
        logHttpError(dependencies.logger, entry.severity, {
          event: 'http.request_failed',
          fields: {
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
          cause: entry.cause,
        });
      },
    });

    const admissionModule = RateLimitModule.register(dependencies.rateLimit);
    const identityModule =
      dependencies.identityRuntime === undefined
        ? undefined
        : IdentityRuntimeModule.register(
            dependencies.identityRuntime,
            admissionModule,
          );
    const webhookRuntime = dependencies.webhookRuntime;
    const scheduleRuntime = dependencies.scheduleRuntime;
    const workflowRuntime = dependencies.workflowRuntime;
    const artifactRuntime = dependencies.artifactRuntime;
    const notificationRuntime = dependencies.notificationRuntime;
    const runtimeReadiness =
      workflowRuntime === undefined &&
      scheduleRuntime === undefined &&
      notificationRuntime === undefined &&
      artifactRuntime === undefined
        ? undefined
        : {
            checkReadiness: async (): Promise<void> => {
              await Promise.all([
                workflowRuntime?.checkReadiness?.(),
                scheduleRuntime?.checkReadiness(),
                notificationRuntime?.checkReadiness(),
                artifactRuntime?.checkReadiness(),
              ]);
            },
          };
    const featureModules = registerFeatureModules(
      config,
      dependencies,
      identityModule,
      admissionModule,
    );

    return {
      module: AppModule,
      imports: [
        ApiLifecycleModule,
        DatabaseModule.register(dependencies.database),
        ...featureModules,
        ObservabilityModule.register(
          dependencies.logger,
          dependencies.telemetry,
        ),
        HttpPlatformModule.register(httpErrorLogger, APPLICATION_ERROR_MAPPERS),
        admissionModule,
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
            if (dependencies.callbackRuntime !== undefined)
              shutdown.register('callback', () =>
                dependencies.callbackRuntime?.close(),
              );
            if (webhookRuntime !== undefined)
              shutdown.register('webhook', () => webhookRuntime.close());
            if (scheduleRuntime !== undefined)
              shutdown.register('schedule', () => scheduleRuntime.close());
            if (notificationRuntime !== undefined)
              shutdown.register('notification', () =>
                notificationRuntime.close(),
              );
            if (artifactRuntime !== undefined)
              shutdown.register('artifact', () => artifactRuntime.close());
            shutdown.register('telemetry', () =>
              dependencies.telemetry.shutdown(),
            );
            return Object.freeze({ registered: true });
          },
        },
        { provide: API_READINESS_LOGGER, useValue: dependencies.logger },
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
  admissionModule: DynamicModule,
): DynamicModule[] {
  if (identityModule === undefined) return [];
  const modules = [CatalogModule.register(identityModule, config.codeSettings)];
  if (dependencies.workflowRuntime === undefined) modules.push(identityModule);
  else
    modules.push(
      WorkflowRuntimeModule.register(
        dependencies.workflowRuntime,
        identityModule,
        admissionModule,
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
  if (dependencies.connectionRuntime === undefined)
    modules.push(
      ConnectionsModule.registerUnavailable(authorization, identityModule),
    );
  modules.push(
    WebhookModule.register(
      dependencies.webhookRuntime,
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
  if (dependencies.notificationRuntime !== undefined)
    modules.push(
      NotificationsModule.register(
        dependencies.notificationRuntime.service,
        dependencies.notificationRuntime.hints,
        {
          authorization: authorization,
          identityModule: identityModule,
          preferences: dependencies.notificationRuntime.preferences,
        },
      ),
    );
  if (dependencies.artifactRuntime !== undefined)
    modules.push(
      ArtifactRuntimeModule.register(
        dependencies.artifactRuntime,
        { identity: identityModule, admission: admissionModule },
        {
          maxObjectBytes:
            config.artifacts?.maxObjectBytes ??
            DEFAULT_ARTIFACT_MAX_OBJECT_BYTES,
        },
      ),
    );
  else
    modules.push(
      ArtifactsModule.registerUnavailable(authorization, identityModule),
    );
  return modules;
}

function logHttpError(
  logger: StructuredLogger,
  severity: HttpErrorLogEntry['severity'],
  {
    event,
    fields,
    cause,
  }: Readonly<{
    event: string;
    fields: Readonly<Record<string, unknown>>;
    cause: unknown;
  }>,
): void {
  if (severity === 'error') logger.error(event, fields, cause);
  else if (severity === 'warn') logger.warn(event, fields, cause);
  else logger.info(event, fields, cause);
}
