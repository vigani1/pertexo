import type { Provider } from '@nestjs/common';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from '../execution/coordinator-runtime.js';
import {
  COORDINATOR_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from './transport-tokens.js';

export function coordinatorRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: COORDINATOR_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<CoordinatorRuntime | undefined> => {
      if (dependencies.coordinatorRuntime !== undefined)
        return dependencies.coordinatorRuntime;
      if (
        dependencies.dispatchConsumerCapabilities !== undefined ||
        !config.outboxDispatcher.enabledJobNames.includes(
          JOB_NAME.advanceWorkflowRun,
        )
      )
        return undefined;
      return createCoordinatorRuntime({
        database: config.database,
        dueWakeupBatchSize: config.coordinator.dueWakeupBatchSize,
        dueWakeupPollIntervalMillis:
          config.coordinator.dueWakeupPollIntervalMillis,
        maximumAdmissions: config.coordinator.maximumAdmissions,
        observer,
        releaseCohort: config.nodeCompatibilityCohort,
        redisUrl: config.redisUrl,
      });
    },
  };
}
