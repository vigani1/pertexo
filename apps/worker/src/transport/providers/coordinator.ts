import type { Provider } from '@nestjs/common';
import type { QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../../config/worker.js';
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from '../../runs/runtime.js';
import {
  COORDINATOR_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from '../tokens.js';

export function coordinatorRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: COORDINATOR_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<CoordinatorRuntime> => {
      if (dependencies.coordinatorRuntime !== undefined)
        return dependencies.coordinatorRuntime;
      return createCoordinatorRuntime(
        {
          database: config.database,
          ...(dependencies.databaseRuntime === undefined
            ? {}
            : { databaseRuntime: dependencies.databaseRuntime }),
          dueWakeupBatchSize: config.coordinator.dueWakeupBatchSize,
          dueWakeupPollIntervalMillis:
            config.coordinator.dueWakeupPollIntervalMillis,
          maximumAdmissions: config.coordinator.maximumAdmissions,
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
