import { verifyWorkerCallbacks } from './runtime/startup/verify-callbacks.js';
import type { createCallbackStore } from '@pertexo/core/runs';
import { verifyWorkerEncryption } from './runtime/startup/verify-encryption.js';
import type {
  DynamicModule,
  INestApplicationContext,
  LoggerService,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/platform';
import type { createEncryptionKeyRepository } from '@pertexo/secrets/server';
import type { TransportMetrics } from '@pertexo/observability';

import type { WorkerConfig } from './config/worker.js';
import { WORKSPACE_DATABASE } from './platform/database/module.js';
import { NestLoggerAdapter } from './platform/observability/module.js';
import { boundedBackgroundTask } from './runtime/background-task-deadline.js';
import { observeWorkspaceArtifactCapacity } from './runtime/health/artifact-metrics.js';
import { WorkerReadinessMonitor } from './runtime/health/readiness-monitor.js';
import { WorkerShutdownCoordinator } from './runtime/shutdown/coordinator.js';
import { OUTBOX_DISPATCHER, TRANSPORT_METRICS } from './transport/module.js';
import type { OutboxDispatcher } from './transport/outbox/dispatch/runtime.js';
import {
  WorkerModule,
  type WorkerModuleDependencies,
} from './worker.module.js';

export type WorkerApplicationDependencies = Pick<
  WorkerModuleDependencies,
  'logger' | 'telemetry'
>;

export type WorkerApplicationCompositionFactories = Readonly<{
  applicationContext(
    module: DynamicModule,
    options: Readonly<{ abortOnError: false; logger: LoggerService }>,
  ): Promise<INestApplicationContext>;
  databaseRuntime: typeof createDatabaseRuntime;
  encryptionKeysRepository?: typeof createEncryptionKeyRepository;
  callbackStore?: typeof createCallbackStore;
}>;

const STARTUP_CLEANUP_LIMIT_MILLIS = 15_000;

const productionFactories: WorkerApplicationCompositionFactories = {
  applicationContext: (module, options) =>
    NestFactory.createApplicationContext(module, options),
  databaseRuntime: createDatabaseRuntime,
};

export async function createWorkerApplication(
  config: WorkerConfig,
  dependencies: WorkerApplicationDependencies,
  factories: WorkerApplicationCompositionFactories = productionFactories,
): Promise<INestApplicationContext> {
  let databaseRuntime: DatabaseRuntime | undefined;
  let dispatcherDatabaseRuntime: DatabaseRuntime | undefined;
  let application: INestApplicationContext;
  try {
    await verifyWorkerEncryption(config, factories.encryptionKeysRepository);
    await verifyWorkerCallbacks(config, factories.callbackStore);
    databaseRuntime = factories.databaseRuntime(config.database, {
      role: 'worker',
    });
    dispatcherDatabaseRuntime = factories.databaseRuntime(
      config.dispatcherDatabase,
      { role: 'dispatcher' },
    );
    application = await factories.applicationContext(
      WorkerModule.register(config, {
        ...dependencies,
        databaseRuntime,
        dispatcherDatabaseRuntime,
      }),
      {
        abortOnError: false,
        logger: new NestLoggerAdapter(dependencies.logger),
      },
    );
  } catch (error: unknown) {
    const cleanupErrors = await cleanupDatabaseRuntimes([
      databaseRuntime,
      dispatcherDatabaseRuntime,
    ]);
    throwWorkerStartupFailure(error, cleanupErrors);
  }

  const shutdown = application.get(WorkerShutdownCoordinator);
  const nestClose = application.close.bind(application);
  let closePromise: Promise<void> | undefined;
  const coordinatedClose = (): Promise<void> => {
    closePromise ??= (async (): Promise<void> => {
      const nestResult = await Promise.allSettled([
        Promise.resolve().then(nestClose),
      ]);
      await shutdown.close();
      const failures = nestResult.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      try {
        shutdown.throwIfFailed();
      } catch (error: unknown) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Worker application shutdown failed',
        );
    })();
    return closePromise;
  };
  const lifecycleApplication = new Proxy(application, {
    get(target, property, receiver) {
      if (property === 'close') return coordinatedClose;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  try {
    const readinessMonitor = application.get(WorkerReadinessMonitor);
    await readinessMonitor.check();
    const dispatcher = application.get<OutboxDispatcher>(OUTBOX_DISPATCHER);
    const metrics = application.get<TransportMetrics>(TRANSPORT_METRICS);
    const database = application.get<WorkspaceDatabase>(WORKSPACE_DATABASE);
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: async (
        workspaceId: string,
        signal: AbortSignal,
      ): Promise<void> => {
        await observeWorkspaceArtifactCapacity(
          database,
          metrics,
          workspaceId,
          signal,
        );
      },
    });
    dispatcher.start();
    try {
      metrics.recordWorkerProcessStart();
      await dependencies.telemetry.flush?.();
    } catch (error: unknown) {
      dependencies.logger.warn('worker.process_start_metric_failed', {}, error);
    }
    readinessMonitor.start();
  } catch (error: unknown) {
    try {
      // Nothing started here is worth waiting on: a step that did begin is
      // recovered from its lease, and a process that can't start must exit.
      await boundedBackgroundTask(
        coordinatedClose(),
        STARTUP_CLEANUP_LIMIT_MILLIS,
      );
    } catch (cleanupError: unknown) {
      throwWorkerStartupFailure(error, [cleanupError]);
    }
    throw error;
  }

  return lifecycleApplication;
}

async function cleanupDatabaseRuntimes(
  runtimes: readonly (DatabaseRuntime | undefined)[],
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(
    runtimes.map((runtime) => Promise.resolve().then(() => runtime?.close())),
  );
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function throwWorkerStartupFailure(
  startupError: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (cleanupErrors.length === 0) throw startupError;
  const flattened = cleanupErrors.flatMap(flattenCleanupError);
  throw new AggregateError(
    [startupError, ...flattened],
    'Worker startup and cleanup did not complete cleanly',
  );
}

function flattenCleanupError(error: unknown): readonly unknown[] {
  return error instanceof AggregateError
    ? (error.errors as unknown[]).flatMap(flattenCleanupError)
    : [error];
}
