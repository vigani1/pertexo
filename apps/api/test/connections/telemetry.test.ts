import { describe, expect, it, vi } from 'vitest';

import {
  createConnectionTelemetry,
  type ConnectionTelemetryOptions,
} from '../../src/connections/telemetry.js';

function options(
  trace: ConnectionTelemetryOptions['trace'],
  overrides: Partial<ConnectionTelemetryOptions> = {},
): ConnectionTelemetryOptions {
  return {
    count: vi.fn(),
    duration: vi.fn(),
    monotonicNow: () => 1_000,
    trace,
    ...overrides,
  };
}

describe('connection telemetry', () => {
  it('records bounded success and failure outcomes without changing command truth', async () => {
    const count = vi.fn();
    const duration = vi.fn();
    const tracedOperations: string[] = [];
    let now = 1_000;
    const telemetry = createConnectionTelemetry({
      count,
      duration,
      trace: <T>(operation: string, work: () => Promise<T>): Promise<T> => {
        tracedOperations.push(operation);
        return work();
      },
      monotonicNow: () => (now += 250),
    });

    await expect(
      telemetry.measure('connection.create', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
    await expect(
      telemetry.measure('connection.revoke', () =>
        Promise.reject(new Error('failed')),
      ),
    ).rejects.toThrow('failed');
    expect(count.mock.calls).toEqual([
      ['connection.create', 'succeeded'],
      ['connection.revoke', 'failed'],
    ]);
    expect(duration).toHaveBeenCalledTimes(2);
    expect(tracedOperations).toEqual([
      'connection.create',
      'connection.revoke',
    ]);
  });

  it.each([
    {
      name: 'synchronous failure before callback',
      trace: <T>(): Promise<T> => {
        throw new Error('trace failed before callback');
      },
    },
    {
      name: 'synchronous failure after callback',
      trace: <T>(_operation: string, work: () => Promise<T>): Promise<T> => {
        void work();
        throw new Error('trace failed after callback');
      },
    },
    {
      name: 'rejection before callback',
      trace: <T>(): Promise<T> =>
        Promise.reject(new Error('trace rejected before callback')),
    },
    {
      name: 'rejection after callback',
      trace: <T>(_operation: string, work: () => Promise<T>): Promise<T> => {
        void work();
        return Promise.reject(new Error('trace rejected after callback'));
      },
    },
  ])('runs work once through $name', async ({ trace }) => {
    const work = vi.fn(() => Promise.resolve('committed'));
    const telemetryOptions = options(trace);
    const telemetry = createConnectionTelemetry(telemetryOptions);

    await expect(
      telemetry.measure('connection.secret.rotate', work),
    ).resolves.toBe('committed');
    expect(work).toHaveBeenCalledTimes(1);
    expect(telemetryOptions.count).toHaveBeenCalledOnce();
    expect(telemetryOptions.duration).toHaveBeenCalledOnce();
  });

  it('returns one business promise when tracing invokes the callback twice', async () => {
    const work = vi.fn(() => Promise.resolve(Object.freeze({ id: 'result' })));
    const telemetry = createConnectionTelemetry(
      options(async (_operation, run) => {
        const first = run();
        const second = run();
        expect(second).toBe(first);
        return first;
      }),
    );

    await expect(telemetry.measure('connection.test', work)).resolves.toEqual({
      id: 'result',
    });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('preserves the exact business rejection when tracing also fails', async () => {
    const businessFailure = Object.freeze({ code: 'business-failure' });
    const work = vi.fn(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- The contract preserves hostile non-Error rejection identity.
      Promise.reject(businessFailure),
    );
    const telemetry = createConnectionTelemetry(
      options((_operation, run) => {
        void run();
        return Promise.reject(new Error('trace failure'));
      }),
    );

    await expect(telemetry.measure('connection.create', work)).rejects.toBe(
      businessFailure,
    );
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('isolates metric and clock failures with nonnegative durations', async () => {
    const count = vi.fn(() => {
      throw new Error('count failed');
    });
    const duration = vi.fn(() => {
      throw new Error('duration failed');
    });
    const clocks = [500, 250, Number.NaN, Number.POSITIVE_INFINITY];
    const telemetry = createConnectionTelemetry(
      options((_operation, run) => run(), {
        count,
        duration,
        monotonicNow: () => {
          const next = clocks.shift();
          if (next === undefined) throw new Error('clock failed');
          return next;
        },
      }),
    );

    await expect(
      telemetry.measure('connection.create', () => Promise.resolve('first')),
    ).resolves.toBe('first');
    await expect(
      telemetry.measure('connection.revoke', () => Promise.resolve('second')),
    ).resolves.toBe('second');
    expect(count).toHaveBeenCalledTimes(2);
    expect(duration.mock.calls).toEqual([
      ['connection.create', 'succeeded', 0],
      ['connection.revoke', 'succeeded', 0],
    ]);
  });
});
