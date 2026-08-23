import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type {
  OutboxDispatcherDatabase,
  WorkspaceDatabase,
} from '@pertexo/database';
import type { QueueProducer } from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';

import type { WorkerConfig } from './config/worker-config.js';
import type { CoordinatorRuntime } from './execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from './execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from './execution/preview-maintenance-runtime.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { ObservabilityModule } from './platform/observability/observability.module.js';
import { WorkerReadiness } from './runtime/worker-readiness.js';
import type { DispatchConsumerCapabilityRegistry } from './transport/dispatch-consumer-capabilities.js';
import { TransportModule } from './transport/transport.module.js';

export type WorkerModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  previewMaintenanceRuntime?: PreviewMaintenanceRuntime;
  database?: WorkspaceDatabase;
  dispatchConsumerCapabilities?: DispatchConsumerCapabilityRegistry;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  queueProducer?: QueueProducer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
  transportMetrics?: TransportMetrics;
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
        ? { releaseCohort: config.nodeCompatibilityCohort }
        : {
            database: dependencies.database,
            releaseCohort: config.nodeCompatibilityCohort,
          };

    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.register(config.database, databaseOptions),
        TransportModule.register(config, {
          ...(dependencies.coordinatorRuntime === undefined
            ? {}
            : { coordinatorRuntime: dependencies.coordinatorRuntime }),
          ...(dependencies.nodeAttemptRuntime === undefined
            ? {}
            : { nodeAttemptRuntime: dependencies.nodeAttemptRuntime }),
          ...(dependencies.previewMaintenanceRuntime === undefined
            ? {}
            : {
                previewMaintenanceRuntime:
                  dependencies.previewMaintenanceRuntime,
              }),
          ...(dependencies.dispatchConsumerCapabilities === undefined
            ? {}
            : {
                dispatchConsumerCapabilities:
                  dependencies.dispatchConsumerCapabilities,
              }),
          ...(dependencies.dispatcherDatabase === undefined
            ? {}
            : { dispatcherDatabase: dependencies.dispatcherDatabase }),
          ...(dependencies.queueProducer === undefined
            ? {}
            : { queueProducer: dependencies.queueProducer }),
          ...(dependencies.transportMetrics === undefined
            ? {}
            : { transportMetrics: dependencies.transportMetrics }),
        }),
        ObservabilityModule.register(
          dependencies.logger,
          dependencies.telemetry,
        ),
      ],
      providers: [WorkerReadiness],
    };
  }
}
