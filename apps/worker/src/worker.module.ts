import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { WorkerConfig } from './config/worker-config.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { ObservabilityModule } from './platform/observability/observability.module.js';
import { WorkerDrainState } from './runtime/worker-drain-state.js';
import { WorkerReadiness } from './runtime/worker-readiness.js';

export type WorkerModuleDependencies = Readonly<{
  database?: WorkspaceDatabase;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

@Module({})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkerModule {
  public static register(
    config: WorkerConfig,
    dependencies: WorkerModuleDependencies,
  ): DynamicModule {
    const databaseOptions =
      dependencies.database === undefined
        ? {}
        : { database: dependencies.database };

    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.register(config.database, databaseOptions),
        ObservabilityModule.register(
          dependencies.logger,
          dependencies.telemetry,
        ),
      ],
      providers: [WorkerDrainState, WorkerReadiness],
    };
  }
}
