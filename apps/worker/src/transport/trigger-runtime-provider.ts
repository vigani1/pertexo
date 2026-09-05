import type { Provider } from '@nestjs/common';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import {
  createTriggerRuntime,
  type TriggerRuntime,
} from '../triggers/trigger-runtime.js';
import {
  QUEUE_CONSUMER_OBSERVER,
  TRIGGER_RUNTIME,
  type TransportModuleDependencies,
} from './transport-tokens.js';

export function triggerRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: TRIGGER_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<TriggerRuntime | undefined> => {
      if (dependencies.triggerRuntime !== undefined)
        return dependencies.triggerRuntime;
      if (
        dependencies.dispatchConsumerCapabilities !== undefined ||
        !config.outboxDispatcher.enabledJobNames.includes(
          JOB_NAME.reconcileWorkflowTriggers,
        )
      )
        return undefined;
      return createTriggerRuntime(
        {
          ...config.triggerRuntime,
          database: config.database,
          ...(dependencies.databaseRuntime === undefined
            ? {}
            : { databaseRuntime: dependencies.databaseRuntime }),
          observer,
          redisUrl: config.redisUrl,
          releaseCohort: config.nodeCompatibilityCohort,
        },
        dependencies.logger === undefined
          ? {}
          : { logger: dependencies.logger },
      );
    },
  };
}
