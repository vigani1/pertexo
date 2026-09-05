import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type {
  OutboxDispatcherDatabase,
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/execution';
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
import type { TriggerRuntime } from './triggers/trigger-runtime.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { ObservabilityModule } from './platform/observability/observability.module.js';
import { WorkerReadiness } from './runtime/worker-readiness.js';
import { WorkerReadinessMonitor } from './runtime/worker-readiness-monitor.js';
import { WorkerResourceMonitor } from './runtime/worker-resource-monitor.js';
import { WorkerDrainState } from './runtime/worker-drain-state.js';
import { WorkerProcessKeepalive } from './runtime/worker-process-keepalive.js';
import type { DispatchConsumerCapabilityRegistry } from './transport/dispatch-consumer-capabilities.js';
import { TransportModule } from './transport/transport.module.js';

export type WorkerModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  previewMaintenanceRuntime?: PreviewMaintenanceRuntime;
  triggerRuntime?: TriggerRuntime;
  database?: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime;
  dispatchConsumerCapabilities?: DispatchConsumerCapabilityRegistry;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  dispatcherDatabaseRuntime?: DatabaseRuntime;
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

    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.register(config.database, databaseOptions),
        TransportModule.register(config, {
          logger: dependencies.logger,
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
          ...(dependencies.triggerRuntime === undefined
            ? {}
            : { triggerRuntime: dependencies.triggerRuntime }),
          ...(dependencies.dispatchConsumerCapabilities === undefined
            ? {}
            : {
                dispatchConsumerCapabilities:
                  dependencies.dispatchConsumerCapabilities,
              }),
          ...(dependencies.dispatcherDatabase === undefined
            ? {}
            : { dispatcherDatabase: dependencies.dispatcherDatabase }),
          ...(dependencies.databaseRuntime === undefined
            ? {}
            : { databaseRuntime: dependencies.databaseRuntime }),
          ...(dependencies.dispatcherDatabaseRuntime === undefined
            ? {}
            : {
                dispatcherDatabaseRuntime:
                  dependencies.dispatcherDatabaseRuntime,
              }),
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
      providers: [
        WorkerReadiness,
        WorkerProcessKeepalive,
        {
          provide: WorkerReadinessMonitor,
          inject: [WorkerReadiness],
          useFactory: (readiness: WorkerReadiness): WorkerReadinessMonitor =>
            new WorkerReadinessMonitor(readiness, dependencies.logger),
        },
        {
          provide: WorkerResourceMonitor,
          inject: [WorkerDrainState],
          useFactory: (drainState: WorkerDrainState): WorkerResourceMonitor =>
            new WorkerResourceMonitor(
              config.resourceSafety,
              drainState,
              dependencies.logger,
            ),
        },
        ...(dependencies.databaseRuntime === undefined
          ? []
          : [
              {
                provide: Symbol('DATABASE_RUNTIME_SHUTDOWN'),
                useValue: {
                  onApplicationShutdown: () =>
                    dependencies.databaseRuntime?.close(),
                },
              },
            ]),
        ...(dependencies.dispatcherDatabaseRuntime === undefined
          ? []
          : [
              {
                provide: Symbol('DISPATCHER_DATABASE_RUNTIME_SHUTDOWN'),
                useValue: {
                  onApplicationShutdown: () =>
                    dependencies.dispatcherDatabaseRuntime?.close(),
                },
              },
            ]),
      ],
    };
  }
}
