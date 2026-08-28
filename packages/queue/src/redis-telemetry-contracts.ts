import { performance } from 'node:perf_hooks';

import type { Redis } from 'ioredis';

export type RedisClientRole =
  | 'queue_consumer'
  | 'queue_producer'
  | 'run_event_publisher'
  | 'run_event_subscriber';

export type RedisOperation =
  | 'close'
  | 'observe'
  | 'ping'
  | 'publish'
  | 'redis_command'
  | 'resubscribe'
  | 'subscribe'
  | 'wait_until_ready';

export type RedisOperationErrorClass =
  'aborted' | 'connection' | 'internal' | 'not_ready' | 'timeout';

export type RedisConnectionEvent = 'close' | 'end' | 'error' | 'ready';

export type RedisOperationObservation = Readonly<{
  readonly clientRole: RedisClientRole;
  readonly durationSeconds: number;
  readonly errorClass?: RedisOperationErrorClass;
  readonly operation: RedisOperation;
  readonly outcome: 'failure' | 'success';
}>;

export interface RedisTelemetryObserver {
  connectionEvent(observation: {
    readonly clientRole: RedisClientRole;
    readonly event: RedisConnectionEvent;
  }): void;
  operationFinished(observation: RedisOperationObservation): void;
}

export function notifyRedisConnectionEvent(
  observer: RedisTelemetryObserver | undefined,
  clientRole: RedisClientRole,
  event: RedisConnectionEvent,
): void {
  try {
    observer?.connectionEvent({ clientRole, event });
  } catch {
    // Dependency telemetry cannot change Redis client behavior.
  }
}

export async function observeRedisOperation<T>(
  observer: RedisTelemetryObserver | undefined,
  clientRole: RedisClientRole,
  operation: RedisOperation,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await execute();
    notifyRedisOperation(observer, {
      clientRole,
      durationSeconds: (performance.now() - startedAt) / 1_000,
      operation,
      outcome: 'success',
    });
    return result;
  } catch (error: unknown) {
    notifyRedisOperation(observer, {
      clientRole,
      durationSeconds: (performance.now() - startedAt) / 1_000,
      errorClass: classifyRedisOperationError(error),
      operation,
      outcome: 'failure',
    });
    throw error;
  }
}

function notifyRedisOperation(
  observer: RedisTelemetryObserver | undefined,
  observation: RedisOperationObservation,
): void {
  try {
    observer?.operationFinished(observation);
  } catch {
    // Dependency telemetry cannot change Redis operation behavior.
  }
}

function classifyRedisOperationError(error: unknown): RedisOperationErrorClass {
  if (!(error instanceof Error)) return 'internal';

  const classification = `${error.name} ${error.message}`.toLowerCase();
  if (
    classification.includes('timeout') ||
    classification.includes('timed out')
  )
    return 'timeout';
  if (classification.includes('abort')) return 'aborted';
  if (classification.includes('not ready')) return 'not_ready';
  if (
    classification.includes('redis') ||
    classification.includes('connection') ||
    classification.includes('socket')
  )
    return 'connection';
  return 'internal';
}

const instrumentedRedisClients = new WeakSet<Redis>();

export function instrumentRedisCommands(
  redis: Redis,
  observer: RedisTelemetryObserver | undefined,
  clientRole: RedisClientRole,
): Redis {
  if (instrumentedRedisClients.has(redis)) return redis;
  if (typeof redis.sendCommand !== 'function') return redis;
  instrumentedRedisClients.add(redis);
  const sendCommand = redis.sendCommand.bind(redis);
  redis.sendCommand = (...args: Parameters<Redis['sendCommand']>): unknown => {
    const startedAt = performance.now();
    try {
      const result: unknown = sendCommand(...args);
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        void Promise.resolve(result).then(
          () => {
            notifyRedisOperation(observer, {
              clientRole,
              durationSeconds: (performance.now() - startedAt) / 1_000,
              operation: 'redis_command',
              outcome: 'success',
            });
          },
          (error: unknown) => {
            notifyRedisOperation(observer, {
              clientRole,
              durationSeconds: (performance.now() - startedAt) / 1_000,
              errorClass: classifyRedisOperationError(error),
              operation: 'redis_command',
              outcome: 'failure',
            });
          },
        );
      }
      return result;
    } catch (error: unknown) {
      notifyRedisOperation(observer, {
        clientRole,
        durationSeconds: (performance.now() - startedAt) / 1_000,
        errorClass: classifyRedisOperationError(error),
        operation: 'redis_command',
        outcome: 'failure',
      });
      throw error;
    }
  };
  if (typeof redis.duplicate === 'function') {
    const duplicate = redis.duplicate.bind(redis);
    redis.duplicate = (...args: Parameters<Redis['duplicate']>): Redis =>
      instrumentRedisCommands(duplicate(...args), observer, clientRole);
  }
  return redis;
}
