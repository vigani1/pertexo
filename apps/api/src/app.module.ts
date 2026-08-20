import 'reflect-metadata';

import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { ApiConfig } from './platform/config/api-config.js';

import { DatabaseModule } from './platform/database/database.module.js';
import { LiveController } from './platform/health/live.controller.js';
import { ReadyController } from './platform/health/ready.controller.js';
import { ApiDrainState } from './platform/health/drain-state.js';
import { HttpPlatformModule } from './platform/http/http.module.js';
import type {
  HttpErrorLogEntry,
  HttpErrorLogger,
} from './platform/http/problem-details.filter.js';
import { ObservabilityModule } from './platform/observability/observability.module.js';
import {
  IdentityRuntimeModule,
  type ApiIdentityRuntime,
} from './platform/identity/identity-runtime.module.js';
import {
  WorkflowRuntimeModule,
  type ApiWorkflowRuntime,
} from './platform/workflow/workflow-runtime.module.js';

export type ApiModuleDependencies = Readonly<{
  database?: WorkspaceDatabase;
  identityRuntime?: ApiIdentityRuntime;
  workflowRuntime?: ApiWorkflowRuntime;
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
        ? {}
        : { database: dependencies.database };
    const httpErrorLogger: HttpErrorLogger = Object.freeze({
      log: (entry: HttpErrorLogEntry): void => {
        dependencies.logger[entry.severity](
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
    const featureModules =
      identityModule === undefined
        ? []
        : dependencies.workflowRuntime === undefined
          ? [identityModule]
          : [
              WorkflowRuntimeModule.register(
                dependencies.workflowRuntime,
                identityModule,
              ),
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
        HttpPlatformModule.register(httpErrorLogger),
      ],
      controllers: [LiveController, ReadyController],
      providers: [ApiDrainState],
    };
  }
}
