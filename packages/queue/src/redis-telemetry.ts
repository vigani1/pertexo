import './server-only.js';

import { metrics, type Attributes, type Meter } from '@opentelemetry/api';

import type {
  RedisClientRole,
  RedisConnectionEvent,
  RedisOperationObservation,
  RedisTelemetryObserver,
} from './redis-telemetry-contracts.js';

export const REDIS_METRIC_NAME = Object.freeze({
  connectionEventCount: 'pertexo.redis.connection.event.count',
  operationCount: 'pertexo.redis.operation.count',
  operationDuration: 'pertexo.redis.operation.duration',
});

function operationAttributes(
  observation: RedisOperationObservation,
): Attributes {
  return {
    client_role: observation.clientRole,
    operation: observation.operation,
    outcome: observation.outcome,
    ...(observation.errorClass === undefined
      ? {}
      : { error_class: observation.errorClass }),
  };
}

/** Creates the queue-owned Redis instruments using an SDK-backed OTel meter. */
export function createRedisTelemetryObserver(
  meter: Meter = metrics.getMeter('@pertexo/queue.redis', '0.0.0'),
): RedisTelemetryObserver {
  const operationCount = meter.createCounter(REDIS_METRIC_NAME.operationCount, {
    description: 'Redis dependency operations by bounded role and outcome',
    unit: '{operation}',
  });
  const operationDuration = meter.createHistogram(
    REDIS_METRIC_NAME.operationDuration,
    {
      description:
        'Redis dependency operation duration by bounded role and outcome',
      unit: 's',
    },
  );
  const connectionEventCount = meter.createCounter(
    REDIS_METRIC_NAME.connectionEventCount,
    {
      description: 'Redis connection lifecycle events by bounded client role',
      unit: '{event}',
    },
  );

  return Object.freeze({
    connectionEvent(observation: {
      readonly clientRole: RedisClientRole;
      readonly event: RedisConnectionEvent;
    }): void {
      connectionEventCount.add(1, {
        client_role: observation.clientRole,
        event: observation.event,
      });
    },
    operationFinished(observation: RedisOperationObservation): void {
      const attributes = operationAttributes(observation);
      operationCount.add(1, attributes);
      operationDuration.record(observation.durationSeconds, attributes);
    },
  });
}

let productionObserver: RedisTelemetryObserver | undefined;

export function createProductionRedisTelemetryObserver(): RedisTelemetryObserver {
  productionObserver ??= createRedisTelemetryObserver();
  return productionObserver;
}
