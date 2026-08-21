import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { WorkspaceDatabase } from '@pertexo/database';
import type { OutboxDispatcherDatabase } from '@pertexo/database';
import type { QueueProducer } from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';

import type { WorkerConfig } from './config/worker-config.js';
import type { CoordinatorRuntime } from './execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from './execution/node-attempt-runtime.js';
import { WORKSPACE_DATABASE } from './platform/database/database.module.js';
import { NestLoggerAdapter } from './platform/observability/observability.module.js';
import { observeWorkspaceArtifactCapacity } from './runtime/artifact-metrics.js';
import { WorkerReadiness } from './runtime/worker-readiness.js';
import type { DispatchConsumerCapabilityRegistry } from './transport/dispatch-consumer-capabilities.js';
import {
  OUTBOX_DISPATCHER,
  TRANSPORT_METRICS,
} from './transport/transport.module.js';
import type { OutboxDispatcher } from './transport/outbox-dispatcher.js';
import { WorkerModule } from './worker.module.js';

export type WorkerApplicationDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  database?: WorkspaceDatabase;
  dispatchConsumerCapabilities?: DispatchConsumerCapabilityRegistry;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  queueProducer?: QueueProducer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
  transportMetrics?: TransportMetrics;
}>;

export async function createWorkerApplication(
  config: WorkerConfig,
  dependencies: WorkerApplicationDependencies,
): Promise<INestApplicationContext> {
  const application = await NestFactory.createApplicationContext(
    WorkerModule.register(config, dependencies),
    { abortOnError: false, logger: new NestLoggerAdapter(dependencies.logger) },
  );

  application.enableShutdownHooks();

  try {
    await application.get(WorkerReadiness).checkReadiness();
    const dispatcher = application.get<OutboxDispatcher>(OUTBOX_DISPATCHER);
    const metrics = application.get<TransportMetrics>(TRANSPORT_METRICS);
    const database = application.get<WorkspaceDatabase>(WORKSPACE_DATABASE);
    dispatcher.configureRuntimeHooks({
      observeArtifactCapacity: async (workspaceId: string): Promise<void> => {
        await observeWorkspaceArtifactCapacity(database, metrics, workspaceId);
      },
    });
    dispatcher.start();
    try {
      metrics.recordWorkerProcessStart();
    } catch (error: unknown) {
      dependencies.logger.warn('worker.process_start_metric_failed', {}, error);
    }
  } catch (error: unknown) {
    await application.close();
    throw error;
  }

  return application;
}
