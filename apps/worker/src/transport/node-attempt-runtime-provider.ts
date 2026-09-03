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

export function nodeAttemptRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
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
      const enabledJobNames = config.outboxDispatcher.enabledJobNames;
      const nodeAttemptEnabled = enabledJobNames.includes(
        JOB_NAME.executeNodeAttempt,
      );
      const previewEnabled = enabledJobNames.includes(
        JOB_NAME.executePreviewAttempt,
      );
      if (!nodeAttemptEnabled && !previewEnabled) return undefined;
      let previewRunStore:
        ReturnType<typeof createDatabasePreviewAttemptRunStore> | undefined;
      try {
        if (previewEnabled) {
          previewRunStore = createDatabasePreviewAttemptRunStore(
            config.database,
          );
        }
        return await composeNodeAttemptRuntime(
          config,
          observer,
          previewEnabled && previewRunStore !== undefined
            ? { runStore: previewRunStore }
            : undefined,
        );
      } catch (error: unknown) {
        await previewRunStore?.close();
        throw error;
      }
    },
  };
}

async function composeNodeAttemptRuntime(
  config: WorkerConfig,
  observer: QueueConsumerObserver,
  preview:
    | Readonly<{
        runStore: ReturnType<typeof createDatabasePreviewAttemptRunStore>;
      }>
    | undefined,
): Promise<NodeAttemptRuntime | undefined> {
  return createNodeAttemptRuntime({
    ...(config.artifactStore === undefined
      ? {}
      : { artifactStore: config.artifactStore }),
    ...(config.connectionEncryption === undefined
      ? {}
      : { connectionEncryption: config.connectionEncryption }),
    database: config.database,
    heartbeatIntervalMillis: config.nodeAttempt.heartbeatIntervalMillis,
    leaseDurationSeconds: config.nodeAttempt.leaseDurationSeconds,
    observer,
    ...(preview === undefined
      ? {}
      : {
          preview: {
            invoker: createPlatformPreviewNodeInvoker({
              releaseCohort: config.nodeCompatibilityCohort,
              registry: createPlatformNodeRegistryForRelease(
                platformServingRegistryRelease(config.nodeCompatibilityCohort),
              ),
            }),
            runStore: preview.runStore,
          },
        }),
    releaseCohort: config.nodeCompatibilityCohort,
    redisUrl: config.redisUrl,
    workerId: config.nodeAttempt.workerId,
  });
}
