import 'reflect-metadata';

import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/api';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { ApiConfig } from './platform/config/api-config.js';

import { DatabaseModule } from './platform/database/database.module.js';
import { LiveController } from './platform/health/live.controller.js';
import {
  API_RUNTIME_READINESS,
  ReadyController,
} from './platform/health/ready.controller.js';
import { ApiDrainState } from './platform/health/drain-state.js';
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

export type ApiModuleDependencies = Readonly<{
  database?: WorkspaceDatabase;
  identityRuntime?: ApiIdentityRuntime;
  connectionRuntime?: ApiConnectionRuntime;
  workflowRuntime?: ApiWorkflowRuntime;
  webhookRuntime?: ApiWebhookRuntime;
  scheduleRuntime?: ApiScheduleRuntime;
  rateLimitConsumer?: RateLimitConsumer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

@Module({
  controllers: [LiveController, ReadyController],
  providers: [ApiDrainState],
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
        ? { releaseCohort: config.nodeCompatibilityCohort }
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
    const authorization =
      dependencies.identityRuntime?.dependencies.authorization;
    const webhookRuntime = dependencies.webhookRuntime;
    const scheduleRuntime = dependencies.scheduleRuntime;
    const workflowRuntime = dependencies.workflowRuntime;
    const runtimeReadiness =
      workflowRuntime === undefined && scheduleRuntime === undefined
        ? undefined
        : {
            checkReadiness: async (): Promise<void> => {
              await Promise.all([
                workflowRuntime?.checkReadiness?.(),
                scheduleRuntime?.checkReadiness(),
              ]);
            },
          };
    const featureModules =
      identityModule === undefined
        ? []
        : [
            ...(dependencies.workflowRuntime === undefined
              ? [identityModule]
              : [
                  WorkflowRuntimeModule.register(
                    dependencies.workflowRuntime,
                    identityModule,
                  ),
                ]),
            ...(dependencies.connectionRuntime === undefined
              ? []
              : [
                  ConnectionRuntimeModule.register(
                    dependencies.connectionRuntime,
                    identityModule,
                  ),
                ]),
            ...(webhookRuntime === undefined || authorization === undefined
              ? []
              : [
                  WebhookModule.register(
                    webhookRuntime.service,
                    authorization,
                    identityModule,
                  ),
                ]),
            ...(scheduleRuntime === undefined || authorization === undefined
              ? []
              : [
                  ScheduleModule.register(
                    scheduleRuntime.service,
                    authorization,
                    identityModule,
                  ),
                ]),
          ];

    return {
      module: AppModule,
      imports: [
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
        ApiDrainState,
        ...(webhookRuntime === undefined
          ? []
          : [
              {
                provide: Symbol('WEBHOOK_RUNTIME_SHUTDOWN'),
                useValue: {
                  onApplicationShutdown: () => webhookRuntime.close(),
                },
              },
            ]),
        ...(runtimeReadiness === undefined
          ? []
          : [{ provide: API_RUNTIME_READINESS, useValue: runtimeReadiness }]),
        ...(scheduleRuntime === undefined
          ? []
          : [
              {
                provide: Symbol('SCHEDULE_RUNTIME_SHUTDOWN'),
                useValue: {
                  onApplicationShutdown: () => scheduleRuntime.close(),
                },
              },
            ]),
      ],
    };
  }
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
