import type { Provider } from '@nestjs/common';
import {
  createOutboxDispatcherDatabase,
  type OutboxDispatcherDatabase,
} from '@pertexo/database/execution';
import {
  createTransportMetrics,
  type TransportMetrics,
} from '@pertexo/observability/transport-metrics';
import {
  createQueueProducer,
  JOB_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
  type QueueProducer,
} from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import type { CoordinatorRuntime } from '../execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from '../execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from '../execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../runtime/worker-drain-state.js';
import type { TriggerRuntime } from '../triggers/trigger-runtime.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapability,
  type DispatchConsumerCapabilityRegistry,
} from './dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import type { OutboxDispatcherOptions } from './outbox-dispatcher.js';
import { createQueueMetricsObserver } from './transport-metrics-adapter.js';
import {
  COORDINATOR_RUNTIME,
  DISPATCH_CONSUMER_CAPABILITIES,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  PREVIEW_MAINTENANCE_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  TRANSPORT_METRICS,
  TRIGGER_RUNTIME,
  type TransportModuleDependencies,
} from './transport-tokens.js';

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
      PREVIEW_MAINTENANCE_RUNTIME,
      TRIGGER_RUNTIME,
    ],
    useFactory: (
      runtime: CoordinatorRuntime | undefined,
      nodeAttemptRuntime: NodeAttemptRuntime | undefined,
      previewMaintenanceRuntime: PreviewMaintenanceRuntime | undefined,
      triggerRuntime: TriggerRuntime | undefined,
    ): DispatchConsumerCapabilityRegistry =>
      dependencies.dispatchConsumerCapabilities ??
      createDispatchConsumerCapabilityRegistry(
        dispatchCapabilityCandidates(
          config,
          runtime,
          nodeAttemptRuntime,
          previewMaintenanceRuntime,
          triggerRuntime,
        ),
      ),
  };
}

function dispatchCapabilityCandidates(
  config: WorkerConfig,
  coordinator: CoordinatorRuntime | undefined,
  nodeAttempt: NodeAttemptRuntime | undefined,
  maintenance: PreviewMaintenanceRuntime | undefined,
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
    maintenance: PreviewMaintenanceRuntime | undefined;
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
