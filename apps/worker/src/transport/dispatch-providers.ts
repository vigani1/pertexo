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
  type QueueConsumer,
  type QueueConsumerObserver,
  type QueueProducer,
} from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker.js';
import type { CoordinatorRuntime } from '../runs/runtime.js';
import type { NodeAttemptRuntime } from '../attempts/runtime.js';
import type { MaintenanceRuntime } from '../maintenance/runtime.js';
import { WorkerDrainState } from '../runtime/drain-state.js';
import type { TriggerRuntime } from '../triggers/runtime.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapability,
  type DispatchConsumerCapabilityRegistry,
} from './dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import type { OutboxDispatcherOptions } from './outbox-dispatcher.js';
import { createQueueMetricsObserver } from './metrics-adapter.js';
import {
  COORDINATOR_RUNTIME,
  DISPATCH_CONSUMER_CAPABILITIES,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  MAINTENANCE_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  TRANSPORT_METRICS,
  TRIGGER_RUNTIME,
  type TransportModuleDependencies,
} from './tokens.js';

export function dispatcherProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: OUTBOX_DISPATCHER,
    inject: [
      WorkerDrainState,
      TRANSPORT_METRICS,
      DISPATCH_CONSUMER_CAPABILITIES,
    ],
    useFactory: (
      drainState: WorkerDrainState,
      metrics: TransportMetrics,
      consumerCapabilities: DispatchConsumerCapabilityRegistry,
    ): Promise<OutboxDispatcher> =>
      createOwnedOutboxDispatcher(
        config,
        dependencies,
        drainState,
        metrics,
        consumerCapabilities,
      ),
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
    consumerCapabilities: DispatchConsumerCapabilityRegistry,
  ): OutboxDispatcher;
}>;

const productionDispatcherFactories: DispatcherCompositionFactories = {
  database: createOutboxDispatcherDatabase,
  producer: createQueueProducer,
  dispatcher: (
    database,
    producer,
    drainState,
    options,
    metrics,
    capabilities,
  ) =>
    new OutboxDispatcher(
      database,
      producer,
      drainState,
      options,
      metrics,
      capabilities,
    ),
};

export async function createOwnedOutboxDispatcher(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  drainState: WorkerDrainState,
  metrics: TransportMetrics,
  consumerCapabilities: DispatchConsumerCapabilityRegistry,
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
      config.outboxDispatcher,
      metrics,
      consumerCapabilities,
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

export function dispatchCapabilitiesProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: DISPATCH_CONSUMER_CAPABILITIES,
    inject: [
      COORDINATOR_RUNTIME,
      NODE_ATTEMPT_RUNTIME,
      MAINTENANCE_RUNTIME,
      TRIGGER_RUNTIME,
    ],
    useFactory: (
      runtime: CoordinatorRuntime | undefined,
      nodeAttemptRuntime: NodeAttemptRuntime | undefined,
      maintenanceRuntime: MaintenanceRuntime | undefined,
      triggerRuntime: TriggerRuntime | undefined,
    ): DispatchConsumerCapabilityRegistry =>
      dependencies.dispatchConsumerCapabilities ??
      createDispatchConsumerCapabilityRegistry(
        dispatchCapabilityCandidates(
          config,
          runtime,
          nodeAttemptRuntime,
          maintenanceRuntime,
          triggerRuntime,
        ),
      ),
  };
}

function dispatchCapabilityCandidates(
  config: WorkerConfig,
  coordinator: CoordinatorRuntime | undefined,
  nodeAttempt: NodeAttemptRuntime | undefined,
  maintenance: MaintenanceRuntime | undefined,
  trigger: TriggerRuntime | undefined,
): readonly DispatchConsumerCapability[] {
  return config.outboxDispatcher.enabledJobNames.flatMap((jobName) => {
    const consumer = dispatchConsumerForJob(jobName, {
      coordinator,
      maintenance,
      nodeAttempt,
      trigger,
    });
    return consumer === undefined ? [] : [{ jobName, consumer }];
  });
}

function dispatchConsumerForJob(
  jobName: string,
  runtimes: Readonly<{
    coordinator: CoordinatorRuntime | undefined;
    maintenance: MaintenanceRuntime | undefined;
    nodeAttempt: NodeAttemptRuntime | undefined;
    trigger: TriggerRuntime | undefined;
  }>,
): QueueConsumer | undefined {
  switch (jobName) {
    case JOB_NAME.advanceWorkflowRun:
      return runtimes.coordinator?.consumer;
    case JOB_NAME.executeNodeAttempt:
    case JOB_NAME.executePreviewAttempt:
      return runtimes.nodeAttempt?.consumer;
    case JOB_NAME.reconcileWorkflowTriggers:
      return runtimes.trigger?.consumer;
    default:
      return runtimes.maintenance?.consumer;
  }
}
