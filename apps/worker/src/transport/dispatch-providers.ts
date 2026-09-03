import type { Provider } from '@nestjs/common';
import { createOutboxDispatcherDatabase } from '@pertexo/database/execution';
import {
  createTransportMetrics,
  type TransportMetrics,
} from '@pertexo/observability/transport-metrics';
import {
  createQueueProducer,
  JOB_NAME,
  type QueueConsumerObserver,
} from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import type { CoordinatorRuntime } from '../execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from '../execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from '../execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../runtime/worker-drain-state.js';
import type { TriggerRuntime } from '../triggers/trigger-runtime.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapabilityRegistry,
} from './dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
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
    ): OutboxDispatcher =>
      new OutboxDispatcher(
        dependencies.dispatcherDatabase ??
          createOutboxDispatcherDatabase(config.dispatcherDatabase),
        dependencies.queueProducer ??
          createQueueProducer({ redisUrl: config.redisUrl }),
        drainState,
        config.outboxDispatcher,
        metrics,
        consumerCapabilities,
      ),
  };
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
      createDispatchConsumerCapabilityRegistry([
        ...(runtime === undefined
          ? []
          : [
              {
                jobName: JOB_NAME.advanceWorkflowRun,
                consumer: runtime.consumer,
              } as const,
            ]),
        ...(nodeAttemptRuntime === undefined
          ? []
          : [
              ...(config.outboxDispatcher.enabledJobNames.includes(
                JOB_NAME.executeNodeAttempt,
              )
                ? [
                    {
                      jobName: JOB_NAME.executeNodeAttempt,
                      consumer: nodeAttemptRuntime.consumer,
                    } as const,
                  ]
                : []),
              ...(config.outboxDispatcher.enabledJobNames.includes(
                JOB_NAME.executePreviewAttempt,
              )
                ? [
                    {
                      jobName: JOB_NAME.executePreviewAttempt,
                      consumer: nodeAttemptRuntime.consumer,
                    } as const,
                  ]
                : []),
            ]),
        ...maintenanceCapabilities(config, previewMaintenanceRuntime),
        ...(triggerRuntime === undefined ||
        !config.outboxDispatcher.enabledJobNames.includes(
          JOB_NAME.reconcileWorkflowTriggers,
        )
          ? []
          : [
              {
                jobName: JOB_NAME.reconcileWorkflowTriggers,
                consumer: triggerRuntime.consumer,
              } as const,
            ]),
      ]),
  };
}

function maintenanceCapabilities(
  config: WorkerConfig,
  runtime: PreviewMaintenanceRuntime | undefined,
) {
  if (runtime === undefined) return [];
  const enabled = config.outboxDispatcher.enabledJobNames;
  return [
    JOB_NAME.reconcilePreviewAttempt,
    JOB_NAME.reconcileUnknownOutcome,
    JOB_NAME.replayWorkflowRun,
    JOB_NAME.deliverRunFailureNotification,
    JOB_NAME.sweepExpiredPreviews,
  ].flatMap((jobName) =>
    enabled.includes(jobName) ? [{ jobName, consumer: runtime.consumer }] : [],
  );
}
