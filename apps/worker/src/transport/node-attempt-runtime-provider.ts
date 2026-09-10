import type { Provider } from '@nestjs/common';
import { platformServingRegistryRelease } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import {
  createNodeAttemptRuntime,
  type NodeAttemptRuntime,
} from '../execution/node-attempt-runtime.js';
import {
  createDatabasePreviewAttemptRunStore,
  createPlatformPreviewNodeInvoker,
} from '../execution/preview-attempt-runtime.js';
import {
  NODE_ATTEMPT_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from './transport-tokens.js';

export type NodeAttemptActivation = Readonly<{
  preview: boolean;
  production: boolean;
}>;

type NodeAttemptRuntimeProviderFactories = Readonly<{
  createPreviewInvoker: typeof createPlatformPreviewNodeInvoker;
  createPreviewRunStore: typeof createDatabasePreviewAttemptRunStore;
  createRuntime: typeof createNodeAttemptRuntime;
}>;

const defaultFactories: NodeAttemptRuntimeProviderFactories = {
  createPreviewInvoker: createPlatformPreviewNodeInvoker,
  createPreviewRunStore: createDatabasePreviewAttemptRunStore,
  createRuntime: createNodeAttemptRuntime,
};

export function nodeAttemptActivation(
  enabledJobNames: readonly string[],
): NodeAttemptActivation {
  return Object.freeze({
    production: enabledJobNames.includes(JOB_NAME.executeNodeAttempt),
    preview: enabledJobNames.includes(JOB_NAME.executePreviewAttempt),
  });
}

async function closePreviewStoreAfterFailure(
  store: ReturnType<typeof createDatabasePreviewAttemptRunStore>,
  primary: unknown,
): Promise<never> {
  try {
    await store.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primary, cleanupError],
      'Preview runtime construction failed and its run store could not be closed',
    );
  }
  throw primary;
}

export function nodeAttemptRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  factories: NodeAttemptRuntimeProviderFactories = defaultFactories,
): Provider {
  return {
    provide: NODE_ATTEMPT_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<NodeAttemptRuntime | undefined> => {
      if (dependencies.nodeAttemptRuntime !== undefined)
        return dependencies.nodeAttemptRuntime;
      if (dependencies.dispatchConsumerCapabilities !== undefined)
        return undefined;
      const activation = nodeAttemptActivation(
        config.outboxDispatcher.enabledJobNames,
      );
      if (!activation.production && !activation.preview) return undefined;
      if (!activation.preview)
        return composeNodeAttemptRuntime(
          config,
          observer,
          dependencies.databaseRuntime,
          undefined,
          factories,
        );

      const previewRunStore = factories.createPreviewRunStore(
        config.database,
        dependencies.databaseRuntime,
      );
      let previewInvoker: ReturnType<typeof createPlatformPreviewNodeInvoker>;
      try {
        previewInvoker = factories.createPreviewInvoker({
          releaseCohort: config.nodeCompatibilityCohort,
          registry: createPlatformNodeRegistryForRelease(
            platformServingRegistryRelease(config.nodeCompatibilityCohort),
          ),
        });
      } catch (error: unknown) {
        return closePreviewStoreAfterFailure(previewRunStore, error);
      }
      // Ownership of both preview resources transfers at this call boundary;
      // createNodeAttemptRuntime closes them on every later failure and close.
      return composeNodeAttemptRuntime(
        config,
        observer,
        dependencies.databaseRuntime,
        { invoker: previewInvoker, runStore: previewRunStore },
        factories,
      );
    },
  };
}

async function composeNodeAttemptRuntime(
  config: WorkerConfig,
  observer: QueueConsumerObserver,
  databaseRuntime: TransportModuleDependencies['databaseRuntime'],
  preview:
    | Readonly<{
        invoker: ReturnType<typeof createPlatformPreviewNodeInvoker>;
        runStore: ReturnType<typeof createDatabasePreviewAttemptRunStore>;
      }>
    | undefined,
  factories: NodeAttemptRuntimeProviderFactories,
): Promise<NodeAttemptRuntime | undefined> {
  return factories.createRuntime({
    ...(config.artifactStore === undefined
      ? {}
      : { artifactStore: config.artifactStore }),
    ...(config.connectionEncryption === undefined
      ? {}
      : { connectionEncryption: config.connectionEncryption }),
    database: config.database,
    ...(databaseRuntime === undefined ? {} : { databaseRuntime }),
    heartbeatIntervalMillis: config.nodeAttempt.heartbeatIntervalMillis,
    leaseDurationSeconds: config.nodeAttempt.leaseDurationSeconds,
    observer,
    productionEnabled: nodeAttemptActivation(
      config.outboxDispatcher.enabledJobNames,
    ).production,
    ...(preview === undefined
      ? {}
      : {
          preview: {
            invoker: preview.invoker,
            runStore: preview.runStore,
          },
        }),
    releaseCohort: config.nodeCompatibilityCohort,
    redisUrl: config.redisUrl,
    workerId: config.nodeAttempt.workerId,
  });
}
