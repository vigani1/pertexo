import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  REDIS_METRIC_NAME,
  createRedisTelemetryObserver,
} from '../src/redis-telemetry.js';
import {
  instrumentRedisCommands,
  observeRedisOperation,
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

    const operationCount = instruments.get(REDIS_METRIC_NAME.operationCount);
    const operationDuration = instruments.get(
      REDIS_METRIC_NAME.operationDuration,
    );
    const connectionCount = instruments.get(
      REDIS_METRIC_NAME.connectionEventCount,
    );
    expect(operationCount?.add.mock.calls).toEqual([[1, operationAttributes]]);
    expect(operationDuration?.record.mock.calls).toEqual([
      [0.25, operationAttributes],
    ]);
    expect(connectionCount?.add.mock.calls).toEqual([
      [
        1,
        {
          client_role: 'queue_producer',
          event: 'close',
        },
      ],
    ]);
    const recordedArguments = JSON.stringify([
      ...(operationCount?.add.mock.calls ?? []),
      ...(operationDuration?.record.mock.calls ?? []),
      ...(connectionCount?.add.mock.calls ?? []),
    ]);
    for (const sensitive of [
      'redis://user:secret@host',
      '11111111-1111-4111-8111-111111111111',
      'payload-secret',
    ])
      expect(recordedArguments).not.toContain(sensitive);
  });

  it.each([
    [new Error('operation timed out'), 'timeout'],
    [new Error('request aborted'), 'aborted'],
    [new Error('queue not ready'), 'not_ready'],
    [new Error('Redis socket unavailable'), 'connection'],
    [new Error('unexpected failure'), 'internal'],
    ['primitive failure', 'internal'],
  ] as const)(
    'classifies bounded failures without replacing %s',
    async (failure, errorClass) => {
      const observer = {
        connectionEvent: vi.fn(),
        operationFinished: vi.fn(),
      };
      const operation = observeRedisOperation(
        observer,
        'queue_producer',
        'publish',
        () =>
          new Promise<never>((_resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Redis collaborators are typed as unknown at this boundary.
            reject(failure);
          }),
      );

      await expect(operation).rejects.toBe(failure);
      expect(observer.operationFinished).toHaveBeenCalledWith(
        expect.objectContaining({ errorClass, outcome: 'failure' }),
      );
    },
  );

  it('contains hostile error inspection and preserves exact operation failures', async () => {
    const getterFailure = new Error('hidden');
    Object.defineProperty(getterFailure, 'name', {
      get() {
        throw new Error('classification getter failed');
      },
    });
    const prototypeFailure = new Proxy(new Error('hidden'), {
      getPrototypeOf() {
        throw new Error('classification prototype failed');
      },
    });
    const observer = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn(),
    };

    for (const failure of [getterFailure, prototypeFailure]) {
      const operation = observeRedisOperation(
        observer,
        'queue_producer',
        'publish',
        () => Promise.reject(failure),
      );
      await expect(operation).rejects.toBe(failure);
    }
    expect(observer.operationFinished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ errorClass: 'internal' }),
    );
    expect(observer.operationFinished).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ errorClass: 'internal' }),
    );
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

  it('returns the original command promise while safely observing hostile rejection', async () => {
    const failure = new Error('hidden');
    Object.defineProperty(failure, 'message', {
      get() {
        throw new Error('classification getter failed');
      },
    });
    const command = Promise.reject(failure);
    const redis = {
      sendCommand: vi.fn(() => command),
    };
    const observer = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn(),
    };
    const instrumented = instrumentRedisCommands(
      redis as unknown as Redis,
      observer,
      'queue_consumer',
    );

    const returned = instrumented.sendCommand({} as never);
    expect(returned).toBe(command);
    await expect(returned).rejects.toBe(failure);
    await vi.waitFor(() => {
      expect(observer.operationFinished).toHaveBeenCalledWith(
        expect.objectContaining({
          errorClass: 'internal',
          operation: 'redis_command',
          outcome: 'failure',
        }),
      );
    });
  });

  it('preserves a synchronous command throw when classification is hostile', () => {
    const failure = new Proxy(new Error('hidden'), {
      getPrototypeOf() {
        throw new Error('classification prototype failed');
      },
    });
    const redis = {
      sendCommand: () => {
        throw failure;
      },
    };
    const observer = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn(),
    };
    const instrumented = instrumentRedisCommands(
      redis as unknown as Redis,
      observer,
      'queue_consumer',
    );

    let caught: unknown;
    try {
      instrumented.sendCommand({} as never);
    } catch (error) {
      caught = error;
    }
    expect(Object.is(caught, failure)).toBe(true);
    expect(observer.operationFinished).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'internal', outcome: 'failure' }),
    );
  });
});
