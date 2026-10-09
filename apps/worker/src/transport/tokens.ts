import type { DatabaseRuntime } from '@pertexo/database/platform';
import type { OutboxDispatcherDatabase } from '@pertexo/database/outbox';
import type {
  StructuredLogger,
  TransportMetrics,
} from '@pertexo/observability';
import type { QueueProducer } from '@pertexo/queue';

import type { CoordinatorRuntime } from '../runs/runtime.js';
import type { FailureNotificationDeliveryCapability } from '../notifications/failure-handler.js';
import type { NodeAttemptRuntime } from '../attempts/runtime.js';
import type { MaintenanceRuntime } from '../maintenance/runtime.js';
import type { TriggerRuntime } from '../triggers/runtime.js';
import type { DispatchConsumerCapabilityRegistry } from './dispatch-consumer-capabilities.js';

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
export const QUEUE_CONSUMER_OBSERVER = Symbol('QUEUE_CONSUMER_OBSERVER');
export const TRANSPORT_METRICS = Symbol('TRANSPORT_METRICS');
export const COORDINATOR_RUNTIME = Symbol('COORDINATOR_RUNTIME');
export const NODE_ATTEMPT_RUNTIME = Symbol('NODE_ATTEMPT_RUNTIME');
export const MAINTENANCE_RUNTIME = Symbol('MAINTENANCE_RUNTIME');
export const TRIGGER_RUNTIME = Symbol('TRIGGER_RUNTIME');
export const DISPATCH_CONSUMER_CAPABILITIES = Symbol(
  'DISPATCH_CONSUMER_CAPABILITIES',
);

export type TransportModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  maintenanceRuntime?: MaintenanceRuntime;
  triggerRuntime?: TriggerRuntime;
  dispatchConsumerCapabilities?: DispatchConsumerCapabilityRegistry;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  databaseRuntime?: DatabaseRuntime;
  dispatcherDatabaseRuntime?: DatabaseRuntime;
  queueProducer?: QueueProducer;
  transportMetrics?: TransportMetrics;
  failureNotificationDelivery?: FailureNotificationDeliveryCapability;
  logger?: StructuredLogger;
}>;
