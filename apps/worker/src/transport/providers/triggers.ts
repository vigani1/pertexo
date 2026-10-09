import type { Provider } from '@nestjs/common';
import type { QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../../config/worker.js';
import {
  createTriggerRuntime,
  type TriggerRuntime,
} from '../../triggers/runtime.js';
import {
  QUEUE_CONSUMER_OBSERVER,
  TRIGGER_RUNTIME,
  type TransportModuleDependencies,
} from '../tokens.js';

export function triggerRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: TRIGGER_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<TriggerRuntime> => {
      if (dependencies.triggerRuntime !== undefined)
        return dependencies.triggerRuntime;
      return createTriggerRuntime(
        {
          ...config.triggerRuntime,
          database: config.database,
          ...(dependencies.databaseRuntime === undefined
            ? {}
            : { databaseRuntime: dependencies.databaseRuntime }),
          observer,
          redisUrl: config.redisUrl,
        },
        dependencies.logger === undefined
          ? {}
          : { logger: dependencies.logger },
      );
    },
  };
}
