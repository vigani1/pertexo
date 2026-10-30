import type { DatabaseRuntime } from '@pertexo/database/platform';
import type { StructuredLogger } from '@pertexo/observability';

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
export const QUEUE_CONSUMER_OBSERVER = Symbol('QUEUE_CONSUMER_OBSERVER');
export const TRANSPORT_METRICS = Symbol('TRANSPORT_METRICS');
export const COORDINATOR_RUNTIME = Symbol('COORDINATOR_RUNTIME');
export const NODE_ATTEMPT_RUNTIME = Symbol('NODE_ATTEMPT_RUNTIME');
export const MAINTENANCE_RUNTIME = Symbol('MAINTENANCE_RUNTIME');
export const TRIGGER_RUNTIME = Symbol('TRIGGER_RUNTIME');

export type TransportModuleDependencies = Readonly<{
  databaseRuntime?: DatabaseRuntime;
  dispatcherDatabaseRuntime?: DatabaseRuntime;
  logger?: StructuredLogger;
}>;
