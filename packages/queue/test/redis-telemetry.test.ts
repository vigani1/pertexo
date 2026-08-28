import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  REDIS_METRIC_NAME,
  createRedisTelemetryObserver,
} from '../src/redis-telemetry.js';
import {
  instrumentRedisCommands,
  type RedisOperationObservation,
} from '../src/redis-telemetry-contracts.js';

describe('Redis telemetry', () => {
  it('records bounded operation and connection attributes', () => {
    const instruments = new Map<
      string,
      { add: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> }
    >();
    const instrument = (name: string) => {
      const value = { add: vi.fn(), record: vi.fn() };
      instruments.set(name, value);
      return value;
    };
    const meter = {
      createCounter: vi.fn((name: string) => instrument(name)),
      createHistogram: vi.fn((name: string) => instrument(name)),
    } as unknown as Parameters<typeof createRedisTelemetryObserver>[0];
    const observer = createRedisTelemetryObserver(meter);

    observer.operationFinished({
      clientRole: 'queue_producer',
      durationSeconds: 0.25,
      errorClass: 'timeout',
      operation: 'publish',
      outcome: 'failure',
    });
    observer.connectionEvent({
      clientRole: 'queue_producer',
      event: 'close',
    });

    const operationAttributes = {
      client_role: 'queue_producer',
      error_class: 'timeout',
      operation: 'publish',
      outcome: 'failure',
    };
    expect(
      instruments.get(REDIS_METRIC_NAME.operationCount)?.add,
    ).toHaveBeenCalledWith(1, operationAttributes);
    expect(
      instruments.get(REDIS_METRIC_NAME.operationDuration)?.record,
    ).toHaveBeenCalledWith(0.25, operationAttributes);
    expect(
      instruments.get(REDIS_METRIC_NAME.connectionEventCount)?.add,
    ).toHaveBeenCalledWith(1, {
      client_role: 'queue_producer',
      event: 'close',
    });

    expect(JSON.stringify([...instruments.values()])).not.toContain('redis://');
  });

  it('observes BullMQ commands on the supplied and duplicated clients', async () => {
    const observations: RedisOperationObservation[] = [];
    const child = {
      duplicate: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve('child-result')),
    };
    const parent = {
      duplicate: vi.fn(() => child),
      sendCommand: vi.fn(() => Promise.resolve('parent-result')),
    };
    const observer = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn((value: RedisOperationObservation) => {
        observations.push(value);
      }),
    };
    const redis = instrumentRedisCommands(
      parent as unknown as Redis,
      observer,
      'queue_consumer',
    );

    await redis.sendCommand({} as never);
    const duplicate = redis.duplicate();
    await duplicate.sendCommand({} as never);
    await vi.waitFor(() => {
      expect(observations).toHaveLength(2);
    });

    expect(observations).toEqual([
      expect.objectContaining({
        clientRole: 'queue_consumer',
        operation: 'redis_command',
        outcome: 'success',
      }),
      expect.objectContaining({
        clientRole: 'queue_consumer',
        operation: 'redis_command',
        outcome: 'success',
      }),
    ]);
  });
});
