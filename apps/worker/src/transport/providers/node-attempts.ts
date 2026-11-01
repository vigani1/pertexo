import type { Provider } from '@nestjs/common';
import { createDatabasePreviewAttemptRunStore } from '@pertexo/core/previews';
import { createNodeSecureHttpClient } from '@pertexo/integrations/server';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import type { QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../../config/worker.js';
import {
  createNodeAttemptRuntime,
  type NodeAttemptRuntime,
} from '../../attempts/delivery/runtime.js';
import { createPlatformPreviewNodeInvoker } from '../../previews/runtime.js';
import {
  NODE_ATTEMPT_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from '../tokens.js';

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
    ): Promise<NodeAttemptRuntime> => {
      const previewRunStore = factories.createPreviewRunStore(
        config.database,
        dependencies.databaseRuntime,
      );
      let previewInvoker: ReturnType<typeof createPlatformPreviewNodeInvoker>;
      try {
        previewInvoker = factories.createPreviewInvoker({
          registry: createPlatformNodeRegistry({
            httpRequest: {
              httpClient: createNodeSecureHttpClient(config.httpRequest),
            },
          }),
        });
      } catch (error: unknown) {
        return closePreviewStoreAfterFailure(previewRunStore, error);
      }
      // Ownership of both preview resources transfers at this call boundary;
      // createNodeAttemptRuntime closes them on every later failure and close.
      return composeNodeAttemptRuntime(config, observer, {
        databaseRuntime: dependencies.databaseRuntime,
        preview: { invoker: previewInvoker, runStore: previewRunStore },
        factories: factories,
      });
    },
  };
}

async function composeNodeAttemptRuntime(
  config: WorkerConfig,
  observer: QueueConsumerObserver,
  {
    databaseRuntime,
    preview,
    factories,
  }: Readonly<{
    databaseRuntime: TransportModuleDependencies['databaseRuntime'];
    preview: Readonly<{
      invoker: ReturnType<typeof createPlatformPreviewNodeInvoker>;
      runStore: ReturnType<typeof createDatabasePreviewAttemptRunStore>;
    }>;
    factories: NodeAttemptRuntimeProviderFactories;
  }>,
): Promise<NodeAttemptRuntime> {
  return factories.createRuntime({
    artifactStore: config.artifactStore,
    ...(config.callbacks === undefined ? {} : { callbacks: config.callbacks }),
    artifactScratchDirectory: config.artifactScratchDirectory,
    codeRunner: config.codeRunner,
    ...(config.connectionEncryption === undefined
      ? {}
      : { connectionEncryption: config.connectionEncryption }),
    database: config.database,
    ...(databaseRuntime === undefined ? {} : { databaseRuntime }),
    heartbeatIntervalMillis: config.nodeAttempt.heartbeatIntervalMillis,
    httpRequest: config.httpRequest,
    leaseDurationSeconds: config.nodeAttempt.leaseDurationSeconds,
    observer,
    preview: { invoker: preview.invoker, runStore: preview.runStore },
    redisUrl: config.redisUrl,
    workerId: config.nodeAttempt.workerId,
  });
}
