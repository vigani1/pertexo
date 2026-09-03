import type { OutboxDispatcherDatabase } from '@pertexo/database/execution';
import type { StructuredLogger } from '@pertexo/observability';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import type { QueueProducer } from '@pertexo/queue';

import type { CoordinatorRuntime } from '../execution/coordinator-runtime.js';
import type { FailureNotificationDeliveryCapability } from '../execution/failure-notification-handler.js';
import type { NodeAttemptRuntime } from '../execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from '../execution/preview-maintenance-runtime.js';
import type { TriggerRuntime } from '../triggers/trigger-runtime.js';
import type { DispatchConsumerCapabilityRegistry } from './dispatch-consumer-capabilities.js';

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
export const QUEUE_CONSUMER_OBSERVER = Symbol('QUEUE_CONSUMER_OBSERVER');
export const TRANSPORT_METRICS = Symbol('TRANSPORT_METRICS');
export const COORDINATOR_RUNTIME = Symbol('COORDINATOR_RUNTIME');
export const NODE_ATTEMPT_RUNTIME = Symbol('NODE_ATTEMPT_RUNTIME');
export const PREVIEW_MAINTENANCE_RUNTIME = Symbol(
  'PREVIEW_MAINTENANCE_RUNTIME',
);
export const TRIGGER_RUNTIME = Symbol('TRIGGER_RUNTIME');
export const DISPATCH_CONSUMER_CAPABILITIES = Symbol(
  'DISPATCH_CONSUMER_CAPABILITIES',
);

export type TransportModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  previewMaintenanceRuntime?: PreviewMaintenanceRuntime;
  triggerRuntime?: TriggerRuntime;
  dispatchConsumerCapabilities?: DispatchConsumerCapabilityRegistry;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  queueProducer?: QueueProducer;
  transportMetrics?: TransportMetrics;
  failureNotificationDelivery?: FailureNotificationDeliveryCapability;
  logger?: StructuredLogger;
}>;
