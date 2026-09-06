import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  createDatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/execution';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';

import type { WorkerConfig } from './config/worker-config.js';
import { WORKSPACE_DATABASE } from './platform/database/database.module.js';
import { NestLoggerAdapter } from './platform/observability/observability.module.js';
import { observeWorkspaceArtifactCapacity } from './runtime/artifact-metrics.js';
import { WorkerReadinessMonitor } from './runtime/worker-readiness-monitor.js';
import {
  OUTBOX_DISPATCHER,
  TRANSPORT_METRICS,
} from './transport/transport.module.js';
import type { OutboxDispatcher } from './transport/outbox-dispatcher.js';
import {
  WorkerModule,
  type WorkerModuleDependencies,
} from './worker.module.js';

export type WorkerApplicationDependencies = WorkerModuleDependencies;

export async function createWorkerApplication(
  config: WorkerConfig,
  dependencies: WorkerApplicationDependencies,
): Promise<INestApplicationContext> {
  const databaseRuntime =
    dependencies.databaseRuntime ??
    (dependencies.database === undefined
      ? createDatabaseRuntime(config.database, { role: 'worker' })
      : undefined);
  const dispatcherDatabaseRuntime =
    dependencies.dispatcherDatabaseRuntime ??
    (dependencies.dispatcherDatabase === undefined
      ? createDatabaseRuntime(config.dispatcherDatabase, {
          role: 'dispatcher',
        })
      : undefined);
  let application: INestApplicationContext;
  try {
    application = await NestFactory.createApplicationContext(
      WorkerModule.register(config, {
        ...dependencies,
        ...(databaseRuntime === undefined ? {} : { databaseRuntime }),
        ...(dispatcherDatabaseRuntime === undefined
          ? {}
          : { dispatcherDatabaseRuntime }),
      }),
      {
        abortOnError: false,
        logger: new NestLoggerAdapter(dependencies.logger),
      },
    );
  } catch (error: unknown) {
    await Promise.allSettled([
      databaseRuntime?.close(),
      dispatcherDatabaseRuntime?.close(),
    ]);
    throw error;
  }

  try {
    await application
      .get<WorkspaceDatabase>(WORKSPACE_DATABASE)
      .checkCompatibility();
    await application.get(WorkerReadinessMonitor).check();
    const dispatcher = application.get<OutboxDispatcher>(OUTBOX_DISPATCHER);
    const metrics = application.get<TransportMetrics>(TRANSPORT_METRICS);
    const database = application.get<WorkspaceDatabase>(WORKSPACE_DATABASE);
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: async (workspaceId: string): Promise<void> => {
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
