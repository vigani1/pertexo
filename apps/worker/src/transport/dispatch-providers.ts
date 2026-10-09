import type { Provider } from '@nestjs/common';
import {
  createOutboxDispatcherDatabase,
  type OutboxDispatcherDatabase,
} from '@pertexo/database/outbox';
import {
  createTransportMetrics,
  type TransportMetrics,
} from '@pertexo/observability';
import {
  createQueueProducer,
  JOB_NAME,
  type JobName,
  type QueueConsumerObserver,
  type QueueProducer,
} from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker.js';
import { WorkerDrainState } from '../runtime/drain-state.js';
import { maintenanceDeliveries } from './maintenance-runtime-provider.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import type { OutboxDispatcherOptions } from './outbox-dispatcher.js';
import { createQueueMetricsObserver } from './metrics-adapter.js';
import {
  OUTBOX_DISPATCHER,
  QUEUE_CONSUMER_OBSERVER,
  TRANSPORT_METRICS,
  type TransportModuleDependencies,
} from './tokens.js';

/**
 * Every job kind this worker consumes. Failure notifications need connection
 * encryption and invitations need invitation email; without them those
 * events wait in the outbox.
 */
export function consumedJobNames(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): readonly JobName[] {
  const deliveries = maintenanceDeliveries(config, dependencies);
  return Object.freeze(
    Object.values(JOB_NAME).filter((jobName) => {
      if (jobName === JOB_NAME.deliverRunFailureNotification)
        return deliveries.notification;
      if (jobName === JOB_NAME.deliverWorkspaceInvitation)
        return deliveries.invitation;
      return true;
    }),
  );
}

export function dispatcherProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: OUTBOX_DISPATCHER,
    inject: [WorkerDrainState, TRANSPORT_METRICS],
    useFactory: (
      drainState: WorkerDrainState,
      metrics: TransportMetrics,
    ): Promise<OutboxDispatcher> =>
      createOwnedOutboxDispatcher(config, dependencies, drainState, metrics),
  };
}

export type DispatcherCompositionFactories = Readonly<{
  database: typeof createOutboxDispatcherDatabase;
  producer: typeof createQueueProducer;
  dispatcher(
    database: OutboxDispatcherDatabase,
    producer: QueueProducer,
    drainState: WorkerDrainState,
    options: OutboxDispatcherOptions,
    metrics: TransportMetrics,
  ): OutboxDispatcher;
}>;

const productionDispatcherFactories: DispatcherCompositionFactories = {
  database: createOutboxDispatcherDatabase,
  producer: createQueueProducer,
  dispatcher: (database, producer, drainState, options, metrics) =>
    new OutboxDispatcher(database, producer, drainState, options, metrics),
};

export async function createOwnedOutboxDispatcher(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  drainState: WorkerDrainState,
  metrics: TransportMetrics,
  factories: DispatcherCompositionFactories = productionDispatcherFactories,
): Promise<OutboxDispatcher> {
  let database: OutboxDispatcherDatabase | undefined;
  let producer: QueueProducer | undefined;
  try {
    database =
      dependencies.dispatcherDatabase ??
      factories.database(
        config.dispatcherDatabase,
        dependencies.dispatcherDatabaseRuntime,
      );
    producer =
      dependencies.queueProducer ??
      factories.producer({ redisUrl: config.redisUrl });
    return factories.dispatcher(
      database,
      producer,
      drainState,
      {
        ...config.outboxDispatcher,
        jobNames: consumedJobNames(config, dependencies),
      },
      metrics,
    );
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => database?.close()),
      Promise.resolve().then(() => producer?.close()),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        [error, ...failures],
        'Outbox dispatcher construction and cleanup failed',
      );
    throw error;
  }
}

export function transportMetricsProvider(
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: TRANSPORT_METRICS,
    useFactory: (): TransportMetrics =>
      dependencies.transportMetrics ?? createTransportMetrics(),
  };
}

export function queueObserverProvider(): Provider {
  return {
    provide: QUEUE_CONSUMER_OBSERVER,
    inject: [TRANSPORT_METRICS],
    useFactory: (metrics: TransportMetrics): QueueConsumerObserver =>
      createQueueMetricsObserver(metrics),
  };
}
