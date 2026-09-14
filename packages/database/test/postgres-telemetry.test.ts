import type { Meter } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  class FakePool {
    static instances: FakePool[] = [];
    static endFailures: { readonly error: unknown }[] = [];
    static connectOutcomes: (
      | Readonly<{
          kind: 'reject';
          error: Error;
          release?: (destroy?: boolean | Error) => void;
        }>
      | Readonly<{
          kind: 'resolve';
          client: { release(destroy?: boolean | Error): void };
          release?: (destroy?: boolean | Error) => void;
        }>
    )[] = [];
    static queryErrors: unknown[] = [];
    static queryResults: { rows: { pid: number }[] }[] = [];
    static queryOutcomes: (
      | Readonly<{ kind: 'reject'; error: unknown }>
      | Readonly<{
          kind: 'resolve';
          result: { rows: { pid: number }[] };
        }>
      | Readonly<{
          kind: 'return';
          promise: Promise<{ rows: { pid: number }[] }>;
        }>
    )[] = [];
    readonly options: Readonly<{
      idle_in_transaction_session_timeout?: number;
      lock_timeout?: number;
      max: number;
      query_timeout?: number;
      statement_timeout?: false | number;
    }>;
    readonly queries: string[] = [];
    readonly queryValues: unknown[][] = [];
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    endCalls = 0;
    endOutcome: Readonly<{ kind: 'reject'; error: unknown }> | undefined;
    private readonly listeners = new Map<
      string,
      ((value: unknown) => void)[]
    >();

    constructor(config: {
      idle_in_transaction_session_timeout?: number;
      lock_timeout?: number;
      max?: number;
      query_timeout?: number;
      statement_timeout?: false | number;
    }) {
      this.options = { ...config, max: config.max ?? 10 };
      FakePool.instances.push(this);
    }

    on(event: string, listener: (value: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, value: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(value);
    }

    connect(
      callback?: (
        error: Error | undefined,
        client: { release(destroy?: boolean | Error): void } | undefined,
        release: (destroy?: boolean | Error) => void,
      ) => void,
    ): Promise<{ release(destroy?: boolean | Error): void }> | undefined {
      const outcome = FakePool.connectOutcomes.shift() ?? {
        kind: 'reject' as const,
        error: new Error('Fake pool connect is not implemented'),
      };
      const release = outcome.release ?? (() => undefined);
      if (callback !== undefined) {
        queueMicrotask(() => {
          if (outcome.kind === 'reject')
            callback(outcome.error, undefined, release);
          else callback(undefined, outcome.client, release);
        });
        return;
      }
      return outcome.kind === 'reject'
        ? Promise.reject(outcome.error)
        : Promise.resolve(outcome.client);
    }

    query(
      query: string,
      values?: unknown[],
    ): Promise<{ rows: { pid: number }[] }> {
      this.queries.push(query);
      if (values !== undefined) this.queryValues.push(values);
      const outcome = FakePool.queryOutcomes.shift();
      if (outcome?.kind === 'reject') {
        // Deliberately exercise hostile non-Error adapter rejections.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(outcome.error);
      }
      if (outcome?.kind === 'resolve') return Promise.resolve(outcome.result);
      if (outcome?.kind === 'return') return outcome.promise;
      const error = FakePool.queryErrors.shift();
      // Exercise bounded telemetry for hostile non-Error adapter rejections.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (error !== undefined) return Promise.reject(error);
      if (Array.isArray(values?.[0]) && (values[0] as unknown[]).length === 0)
        return Promise.resolve({ rows: [] });
      return Promise.resolve(FakePool.queryResults.shift() ?? { rows: [] });
    }

    end(): Promise<void> {
      this.endCalls += 1;
      if (this.endOutcome?.kind === 'reject') {
        // Deliberately exercise hostile non-Error adapter rejections.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(this.endOutcome.error);
      }
      const failure = FakePool.endFailures.shift();
      // Deliberately exercise hostile non-Error adapter rejections.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (failure !== undefined) return Promise.reject(failure.error);
      return Promise.resolve();
    }
  }

  return { FakePool };
});

vi.mock('pg', () => ({ Pool: pg.FakePool }));

import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../src/platform/postgres-telemetry.js';

interface Measurement {
  readonly attributes?: Record<string, string>;
  readonly value: number;
}

function fakeMeter(): {
  readonly callbacks: Map<
    string,
    (result: {
      observe(value: number, attributes?: Record<string, string>): void;
    }) => void
  >;
  readonly measurements: Map<string, Measurement[]>;
  readonly meter: Meter;
} {
  const callbacks = new Map<
    string,
    (result: {
      observe(value: number, attributes?: Record<string, string>): void;
    }) => void
  >();
  const measurements = new Map<string, Measurement[]>();
  const meter = {
    createHistogram(name: string) {
      return {
        record(value: number, attributes?: Record<string, string>) {
          const values = measurements.get(name) ?? [];
          values.push({
            value,
            ...(attributes === undefined ? {} : { attributes }),
          });
          measurements.set(name, values);
        },
      };
    },
    createObservableGauge(name: string) {
      return {
        addCallback(
          callback: (result: {
            observe(value: number, attributes?: Record<string, string>): void;
          }) => void,
        ) {
          callbacks.set(name, callback);
        },
      };
    },
  } as unknown as Meter;
  return { callbacks, measurements, meter };
}

function observableMeasurements(
  callbacks: Map<
    string,
    (result: {
      observe(value: number, attributes?: Record<string, string>): void;
    }) => void
  >,
  name: string,
): Measurement[] {
  const observed: Measurement[] = [];
  callbacks.get(name)?.({
    observe: (value, attributes) => {
      observed.push({
        value,
        ...(attributes === undefined ? {} : { attributes }),
      });
    },
  });
  return observed;
}

function poolAt(index: number): InstanceType<typeof pg.FakePool> {
  const pool = pg.FakePool.instances[index];
  if (pool === undefined)
    throw new Error(`Fake pool ${String(index)} is missing`);
  return pool;
}

type ClientQueryOutcome =
  | Readonly<{
      kind: 'callback';
      error?: Error;
      receiver?: object;
      result?: unknown;
      returned?: unknown;
    }>
  | Readonly<{ kind: 'reject'; error: unknown }>
  | Readonly<{ kind: 'resolve'; result: unknown }>
  | Readonly<{ kind: 'throw'; error: unknown }>;

function telemetryClient(outcomes: ClientQueryOutcome[]) {
  const listeners = new Map<string, ((value?: unknown) => void)[]>();
  const release = vi.fn();
  const query = vi.fn((...args: unknown[]): unknown => {
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error('query outcome is missing');
    if (outcome.kind === 'throw') {
      // Preserve arbitrary synchronous adapter behavior through instrumentation.
      throw outcome.error;
    }
    if (outcome.kind === 'reject') {
      // Preserve arbitrary asynchronous adapter behavior through instrumentation.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(outcome.error);
    }
    if (outcome.kind === 'resolve') return Promise.resolve(outcome.result);
    const callback = args.at(-1) as (
      this: unknown,
      error: Error | undefined,
      result: unknown,
    ) => unknown;
    callback.call(outcome.receiver, outcome.error, outcome.result);
    return outcome.returned;
  });
  const client = {
    emit(event: string, value?: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    once(event: string, listener: (value?: unknown) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return client;
    },
    query,
    release,
  };
  return { client, query, release };
}

describe('PostgreSQL telemetry pool', () => {
  beforeEach(() => {
    pg.FakePool.instances.length = 0;
    pg.FakePool.connectOutcomes.length = 0;
    pg.FakePool.endFailures.length = 0;
    pg.FakePool.queryErrors.length = 0;
    pg.FakePool.queryResults.length = 0;
    pg.FakePool.queryOutcomes.length = 0;
  });

  it('does not mistake an undefined pool-end rejection for success', async () => {
    pg.FakePool.endFailures.push({ error: undefined });
    const pool = createDatabasePool(
      {},
      { monitorLockWaits: false, role: 'maintenance' },
    );

    await expect(pool.end()).rejects.toMatchObject({
      message: 'Cleanup failed',
    });
  });

  it('applies bounded role deadlines and preserves narrower explicit values', async () => {
    const first = createDatabasePool(
      { lock_timeout: 750, max: 1 },
      { monitorLockWaits: false, role: 'api' },
    );
    const second = createDatabasePool(
      { max: 1 },
      { monitorLockWaits: false, role: 'maintenance' },
    );

    expect(poolAt(0).options).toMatchObject({
      idle_in_transaction_session_timeout: 35_000,
      lock_timeout: 750,
      query_timeout: 35_000,
      statement_timeout: 30_000,
    });
    expect(poolAt(1).options).toMatchObject({
      idle_in_transaction_session_timeout: 305_000,
      lock_timeout: 15_000,
      query_timeout: 305_000,
      statement_timeout: 300_000,
    });

    await first.end();
    await second.end();
  });

  it('rejects disabled or invalid caller deadline overrides', () => {
    expect(() =>
      createDatabasePool(
        { lock_timeout: -1 },
        { monitorLockWaits: false, role: 'worker' },
      ),
    ).toThrow('lock_timeout must be a positive safe integer');
  });

  it('reports pool state by bounded database authority', async () => {
    const telemetry = fakeMeter();
    const first = createDatabasePool(
      { max: 4, user: 'pertexo_api' },
      { meter: telemetry.meter, monitorLockWaits: false },
    );
    const second = createDatabasePool(
      { max: 6, user: 'pertexo_worker' },
      { meter: telemetry.meter, monitorLockWaits: false },
    );
    Object.assign(poolAt(0), {
      idleCount: 1,
      totalCount: 3,
      waitingCount: 2,
    });
    Object.assign(poolAt(1), {
      idleCount: 2,
      totalCount: 4,
      waitingCount: 1,
    });

    expect(
      observableMeasurements(
        telemetry.callbacks,
        DATABASE_METRIC_NAME.poolConnections,
      ),
    ).toEqual([
      { attributes: { pool_role: 'api' }, value: 3 },
      { attributes: { pool_role: 'worker' }, value: 4 },
    ]);
    expect(
      observableMeasurements(
        telemetry.callbacks,
        DATABASE_METRIC_NAME.poolSaturation,
      ),
    ).toEqual([
      { attributes: { pool_role: 'api' }, value: 0.5 },
      { attributes: { pool_role: 'worker' }, value: 1 / 3 },
    ]);
    expect(
      observableMeasurements(
        telemetry.callbacks,
        DATABASE_METRIC_NAME.poolWaiters,
      ),
    ).toEqual([
      { attributes: { pool_role: 'api' }, value: 2 },
      { attributes: { pool_role: 'worker' }, value: 1 },
    ]);

    await first.end();
    await second.end();
  });

  it('uses an explicit role and aggregates saturation across its process budget', async () => {
    const telemetry = fakeMeter();
    const first = createDatabasePool(
      { max: 4, user: 'custom_runtime' },
      { meter: telemetry.meter, monitorLockWaits: false, role: 'api' },
    );
    const second = createDatabasePool(
      { max: 6, user: 'another_custom_runtime' },
      { meter: telemetry.meter, monitorLockWaits: false, role: 'api' },
    );
    Object.assign(poolAt(0), { idleCount: 0, totalCount: 4 });
    Object.assign(poolAt(1), { idleCount: 5, totalCount: 6 });

    expect(
      observableMeasurements(
        telemetry.callbacks,
        DATABASE_METRIC_NAME.poolSaturation,
      ),
    ).toEqual([{ attributes: { pool_role: 'api' }, value: 0.5 }]);

    await first.end();
    await second.end();
  });

  it('records bounded query and transaction outcomes without SQL', async () => {
    const telemetry = fakeMeter();
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false },
    );
    const client = {
      once: vi.fn(),
      release: vi.fn(),
      query(query: string): Promise<{ rows: unknown[] }> {
        return query === 'delete from secret_table'
          ? Promise.reject(new Error('database rejected query'))
          : Promise.resolve({ rows: [] });
      },
    };
    poolAt(0).emit('connect', client);
    Object.assign(client, { release: vi.fn() });

    await client.query('begin');
    await client.query('select * from secret_table where identity = 42');
    await client.query('commit');
    await expect(client.query('delete from secret_table')).rejects.toThrow(
      'database rejected query',
    );

    const queries = telemetry.measurements.get(
      DATABASE_METRIC_NAME.queryDuration,
    );
    expect(queries?.map((value) => value.attributes)).toEqual([
      { operation: 'begin', outcome: 'success' },
      { operation: 'select', outcome: 'success' },
      { operation: 'commit', outcome: 'success' },
      { operation: 'delete', outcome: 'error' },
    ]);
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.transactionDuration)?.[0]
        ?.attributes,
    ).toEqual({ outcome: 'committed' });
    expect(JSON.stringify(queries)).not.toContain('secret_table');
    expect(JSON.stringify(queries)).not.toContain('identity');

    await pool.end();
  });

  it('preserves callback query receiver, result, error and synchronous return', async () => {
    const telemetry = fakeMeter();
    const callbackReceiver = {};
    const selectedResult = { rows: [{ value: 1 }] };
    const queryFailure = new Error('query failed');
    const fixture = telemetryClient([
      {
        kind: 'callback',
        receiver: callbackReceiver,
        result: selectedResult,
        returned: 'callback-started',
      },
      {
        kind: 'callback',
        error: queryFailure,
        receiver: callbackReceiver,
        returned: 'failed-callback-started',
      },
    ]);
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false },
    );
    poolAt(0).emit('connect', fixture.client);
    const successCallback = vi.fn(function (
      this: unknown,
      error: Error | undefined,
      result: unknown,
    ) {
      expect(this).toBe(callbackReceiver);
      expect(error).toBeUndefined();
      expect(result).toBe(selectedResult);
    });
    const failureCallback = vi.fn(function (
      this: unknown,
      error: Error | undefined,
      result: unknown,
    ) {
      expect(this).toBe(callbackReceiver);
      expect(error).toBe(queryFailure);
      expect(result).toBeUndefined();
    });

    expect(fixture.client.query('select 1', successCallback)).toBe(
      'callback-started',
    );
    expect(fixture.client.query('update secret', failureCallback)).toBe(
      'failed-callback-started',
    );
    expect(successCallback).toHaveBeenCalledOnce();
    expect(failureCallback).toHaveBeenCalledOnce();
    expect(
      telemetry.measurements
        .get(DATABASE_METRIC_NAME.queryDuration)
        ?.map(({ attributes }) => attributes),
    ).toEqual([
      { operation: 'select', outcome: 'success' },
      { operation: 'update', outcome: 'error' },
    ]);

    await pool.end();
  });

  it('records synchronous query failure without replacing its value', async () => {
    const telemetry = fakeMeter();
    const failure = { code: 'synchronous-query-failure' };
    const fixture = telemetryClient([{ kind: 'throw', error: failure }]);
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false },
    );
    poolAt(0).emit('connect', fixture.client);

    expect(() => fixture.client.query('copy secret')).toThrow(failure);
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.queryDuration)?.[0]
        ?.attributes,
    ).toEqual({ operation: 'copy', outcome: 'error' });

    await pool.end();
  });

  it('records rollback, abandoned, destroyed and connection-ended transactions once', async () => {
    const telemetry = fakeMeter();
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false },
    );
    const rolledBack = telemetryClient([
      { kind: 'resolve', result: { rows: [] } },
      { kind: 'resolve', result: { rows: [] } },
    ]);
    const abandoned = telemetryClient([
      { kind: 'resolve', result: { rows: [] } },
    ]);
    const destroyed = telemetryClient([
      { kind: 'resolve', result: { rows: [] } },
    ]);
    const connectionEnded = telemetryClient([
      { kind: 'resolve', result: { rows: [] } },
    ]);
    for (const fixture of [rolledBack, abandoned, destroyed, connectionEnded]) {
      poolAt(0).emit('connect', fixture.client);
      pg.FakePool.connectOutcomes.push({
        kind: 'resolve',
        client: fixture.client,
      });
      await pool.connect();
    }

    await rolledBack.client.query('begin');
    await rolledBack.client.query('rollback');
    await abandoned.client.query('begin');
    abandoned.client.release();
    await destroyed.client.query('begin');
    destroyed.client.release(new Error('destroyed checkout'));
    await connectionEnded.client.query('begin');
    connectionEnded.client.emit('error', new Error('socket failed'));
    connectionEnded.client.emit('end');

    expect(
      telemetry.measurements
        .get(DATABASE_METRIC_NAME.transactionDuration)
        ?.map(({ attributes }) => attributes),
    ).toEqual([
      { outcome: 'rolled_back' },
      { outcome: 'abandoned' },
      { outcome: 'connection_error' },
      { outcome: 'connection_error' },
    ]);

    await pool.end();
  });

  it('contains meter callback failures without changing query or release results', async () => {
    const meter = {
      createHistogram() {
        return {
          record() {
            throw new Error('meter unavailable');
          },
        };
      },
      createObservableGauge() {
        return { addCallback: vi.fn() };
      },
    } as unknown as Meter;
    const result = { rows: [{ value: 1 }] };
    const fixture = telemetryClient([
      { kind: 'resolve', result },
      { kind: 'resolve', result: { rows: [] } },
    ]);
    const pool = createDatabasePool({}, { meter, monitorLockWaits: false });
    poolAt(0).emit('connect', fixture.client);

    await expect(fixture.client.query('select 1')).resolves.toBe(result);
    await expect(fixture.client.query('begin')).resolves.toEqual({ rows: [] });
    expect(() => {
      fixture.client.release();
    }).not.toThrow();

    await pool.end();
  });

  it('records failed pool checkout duration without connection details', async () => {
    const telemetry = fakeMeter();
    const pool = createDatabasePool(
      { connectionString: 'postgresql://secret@db/app' },
      { meter: telemetry.meter, monitorLockWaits: false, role: 'api' },
    );

    await expect(pool.connect()).rejects.toThrow('not implemented');
    const checkout = telemetry.measurements.get(
      DATABASE_METRIC_NAME.poolCheckoutDuration,
    );
    expect(checkout).toHaveLength(1);
    expect(checkout?.[0]?.attributes).toEqual({
      outcome: 'error',
      pool_role: 'api',
    });
    expect(JSON.stringify(checkout)).not.toContain('secret');
    await pool.end();
  });

  it('preserves promise checkout clients and records successful release', async () => {
    const telemetry = fakeMeter();
    const originalRelease = vi.fn();
    const client = { release: originalRelease };
    pg.FakePool.connectOutcomes.push({ kind: 'resolve', client });
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false, role: 'operator' },
    );

    await expect(pool.connect()).resolves.toBe(client);
    client.release(true);
    expect(originalRelease).toHaveBeenCalledWith(true);
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.poolCheckoutDuration),
    ).toEqual([
      expect.objectContaining({
        attributes: { outcome: 'success', pool_role: 'operator' },
      }),
    ]);

    await pool.end();
  });

  it('preserves callback checkout receiver, values and release behavior', async () => {
    const telemetry = fakeMeter();
    const originalRelease = vi.fn();
    const poolRelease = vi.fn();
    const client = { release: originalRelease };
    pg.FakePool.connectOutcomes.push({
      kind: 'resolve',
      client,
      release: poolRelease,
    });
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false, role: 'api' },
    );

    await new Promise<void>((resolve, reject) => {
      pool.connect(function (this: undefined, error, selectedClient, release) {
        try {
          expect(this).toBeUndefined();
          expect(error).toBeUndefined();
          expect(selectedClient).toBe(client);
          release(new Error('destroy checkout'));
          resolve();
        } catch (failure: unknown) {
          reject(
            failure instanceof Error ? failure : new Error('assertion failed'),
          );
        }
      });
    });
    expect(originalRelease).toHaveBeenCalledWith(expect.any(Error));
    expect(poolRelease).not.toHaveBeenCalled();
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.poolCheckoutDuration)?.[0]
        ?.attributes,
    ).toEqual({ outcome: 'success', pool_role: 'api' });

    await pool.end();
  });

  it('preserves callback checkout errors and the pool release callback', async () => {
    const telemetry = fakeMeter();
    const checkoutFailure = new Error('checkout failed');
    const poolRelease = vi.fn();
    pg.FakePool.connectOutcomes.push({
      kind: 'reject',
      error: checkoutFailure,
      release: poolRelease,
    });
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false, role: 'worker' },
    );

    await new Promise<void>((resolve, reject) => {
      pool.connect((error, client, release) => {
        try {
          expect(error).toBe(checkoutFailure);
          expect(client).toBeUndefined();
          release(true);
          resolve();
        } catch (failure: unknown) {
          reject(
            failure instanceof Error ? failure : new Error('assertion failed'),
          );
        }
      });
    });
    expect(poolRelease).toHaveBeenCalledWith(true);
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.poolCheckoutDuration)?.[0]
        ?.attributes,
    ).toEqual({ outcome: 'error', pool_role: 'worker' });

    await pool.end();
  });

  it('instruments a client release freshly on every checkout', async () => {
    const telemetry = fakeMeter();
    const originalRelease = vi.fn();
    const client = { release: originalRelease };
    pg.FakePool.connectOutcomes.push(
      { kind: 'resolve', client },
      { kind: 'resolve', client },
    );
    const pool = createDatabasePool(
      {},
      { meter: telemetry.meter, monitorLockWaits: false, role: 'maintenance' },
    );

    const first = await pool.connect();
    first.release();
    client.release = originalRelease;
    const second = await pool.connect();
    second.release(new Error('destroy second checkout'));

    expect(originalRelease).toHaveBeenCalledTimes(2);
    expect(originalRelease).toHaveBeenNthCalledWith(1, undefined);
    expect(originalRelease).toHaveBeenNthCalledWith(2, expect.any(Error));
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.poolCheckoutDuration),
    ).toHaveLength(2);

    await pool.end();
  });

  it('reports sanitized idle-client and monitor failures without changing pool behavior', async () => {
    const telemetry = fakeMeter();
    const record = vi.fn();
    pg.FakePool.queryErrors.push(new Error('secret monitor detail'));
    const pool = createDatabasePool(
      { connectionString: 'postgresql://secret@db/app' },
      {
        diagnostics: { record },
        lockWaitSampleIntervalMs: 100,
        meter: telemetry.meter,
        role: 'worker',
      },
    );
    poolAt(0).emit('error', new TypeError('secret idle detail'));

    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith({
        errorType: 'Error',
        operation: 'lock_wait_sample',
        poolRole: 'worker',
      });
    });
    expect(record).toHaveBeenCalledWith({
      errorType: 'Error',
      operation: 'idle_pool_error',
      poolRole: 'worker',
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('secret');

    await pool.end();
  });

  it.each([
    [
      'renamed error',
      Object.assign(new Error('secret'), { name: 'SecretDbError' }),
      'Error',
    ],
    [
      'throwing prototype',
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('secret prototype failure');
          },
        },
      ),
      'NonError',
    ],
    ['undefined', undefined, 'NonError'],
    ['primitive', 'secret primitive', 'NonError'],
  ] as const)(
    'bounds %s diagnostic classification without exposing adapter detail',
    async (_label, failure, errorType) => {
      const record = vi.fn();
      pg.FakePool.queryOutcomes.push({ kind: 'reject', error: failure });
      const pool = createDatabasePool(
        { connectionString: 'postgresql://secret@db/app' },
        {
          diagnostics: { record },
          lockWaitSampleIntervalMs: 100,
          role: 'worker',
        },
      );

      poolAt(0).emit('error', failure);
      await vi.waitFor(() => {
        expect(record).toHaveBeenCalledWith({
          errorType,
          operation: 'lock_wait_sample',
          poolRole: 'worker',
        });
      });
      expect(record).toHaveBeenCalledWith({
        errorType,
        operation: 'idle_pool_error',
        poolRole: 'worker',
      });
      expect(JSON.stringify(record.mock.calls)).not.toContain('secret');

      await pool.end();
    },
  );

  it('contains diagnostics failures for idle and sampled pool errors', async () => {
    const diagnosticsFailure = new Error('diagnostics unavailable');
    const record = vi.fn(() => {
      throw diagnosticsFailure;
    });
    pg.FakePool.queryOutcomes.push({
      kind: 'reject',
      error: new Error('sample failed'),
    });
    const pool = createDatabasePool(
      {},
      {
        diagnostics: { record },
        lockWaitSampleIntervalMs: 100,
      },
    );

    expect(() => {
      poolAt(0).emit('error', new Error('idle failed'));
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledTimes(2);
    });

    await pool.end();
  });

  it('samples lock waits on a dedicated uninstrumented pool', async () => {
    const telemetry = fakeMeter();
    pg.FakePool.queryResults.push({ rows: [{ pid: 17 }] }, { rows: [] });
    const pool = createDatabasePool(
      {},
      {
        lockWaitSampleIntervalMs: 100,
        meter: telemetry.meter,
      },
    );
    poolAt(0).emit('connect', {
      once: vi.fn(),
      processID: 17,
      query: () => Promise.resolve({ rows: [] }),
      release: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(
        observableMeasurements(
          telemetry.callbacks,
          DATABASE_METRIC_NAME.lockWaitActive,
        )[0]?.value,
      ).toBe(1);
    });
    expect(pg.FakePool.instances).toHaveLength(2);
    expect(poolAt(1).queries[0]).toContain('pg_stat_activity');
    expect(poolAt(1).queries[0]).toContain('pid = any($1::integer[])');
    expect(poolAt(1).queryValues).toContainEqual([[17]]);

    await vi.waitFor(() => {
      expect(
        telemetry.measurements.get(DATABASE_METRIC_NAME.lockWaitDuration),
      ).toHaveLength(1);
    });
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.lockWaitDuration)?.[0]
        ?.attributes,
    ).toEqual({ outcome: 'completed' });

    await pool.end();
  });

  it('shares one lock sampler across pools with the same connection authority', async () => {
    const telemetry = fakeMeter();
    const config = { connectionString: 'postgresql://runtime:test@db/app' };
    const first = createDatabasePool(config, {
      lockWaitSampleIntervalMs: 100,
      meter: telemetry.meter,
    });
    const second = createDatabasePool(config, {
      lockWaitSampleIntervalMs: 100,
      meter: telemetry.meter,
    });

    expect(pg.FakePool.instances).toHaveLength(3);
    const firstClose = first.end();
    expect(first.end()).toBe(firstClose);
    await firstClose;
    expect(poolAt(0).endCalls).toBe(1);
    expect(poolAt(1).endCalls).toBe(0);
    expect(pg.FakePool.instances[1]?.queries.length).toBeGreaterThan(0);
    await second.end();
    expect(poolAt(1).endCalls).toBe(1);
    expect(poolAt(2).endCalls).toBe(1);
  });

  it('does not consume another pool sampler reference after a cached close rejection', async () => {
    const telemetry = fakeMeter();
    const config = { connectionString: 'postgresql://runtime:test@db/app' };
    const first = createDatabasePool(config, {
      lockWaitSampleIntervalMs: 100,
      meter: telemetry.meter,
    });
    const second = createDatabasePool(config, {
      lockWaitSampleIntervalMs: 100,
      meter: telemetry.meter,
    });
    poolAt(0).endOutcome = { kind: 'reject', error: undefined };

    const firstClose = first.end();
    await expect(firstClose).rejects.toMatchObject({
      message: 'Cleanup failed',
    });
    expect(first.end()).toBe(firstClose);
    await expect(first.end()).rejects.toMatchObject({
      message: 'Cleanup failed',
    });
    expect(poolAt(0).endCalls).toBe(1);
    expect(poolAt(1).endCalls).toBe(0);

    await second.end();
    expect(poolAt(1).endCalls).toBe(1);
    expect(poolAt(2).endCalls).toBe(1);
  });

  it('aggregates business and final sampler cleanup failures once', async () => {
    const telemetry = fakeMeter();
    const pool = createDatabasePool(
      {},
      { lockWaitSampleIntervalMs: 100, meter: telemetry.meter },
    );
    const poolFailure = new Error('business pool close failed');
    const monitorFailure = new Error('monitor pool close failed');
    poolAt(0).endOutcome = { kind: 'reject', error: poolFailure };
    poolAt(1).endOutcome = { kind: 'reject', error: monitorFailure };

    const close = pool.end();
    await expect(close).rejects.toMatchObject({
      errors: [poolFailure, monitorFailure],
    });
    expect(pool.end()).toBe(close);
    expect(poolAt(0).endCalls).toBe(1);
    expect(poolAt(1).endCalls).toBe(1);
  });

  it('settles an active sample before final close and starts no replacement', async () => {
    vi.useFakeTimers();
    try {
      const sample = Promise.withResolvers<{ rows: { pid: number }[] }>();
      pg.FakePool.queryOutcomes.push({
        kind: 'return',
        promise: sample.promise,
      });
      const pool = createDatabasePool(
        {},
        { lockWaitSampleIntervalMs: 100, meter: fakeMeter().meter },
      );
      expect(poolAt(1).queries).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(poolAt(1).queries).toHaveLength(1);
      const close = pool.end();
      let closed = false;
      void close.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(poolAt(1).endCalls).toBe(0);

      sample.resolve({ rows: [] });
      await close;
      expect(poolAt(1).endCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(poolAt(1).queries).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not silently share a lock sampler with a different cadence', async () => {
    const telemetry = fakeMeter();
    const config = { connectionString: 'postgresql://runtime:test@db/app' };
    const first = createDatabasePool(config, {
      lockWaitSampleIntervalMs: 100,
      meter: telemetry.meter,
    });
    const second = createDatabasePool(config, {
      lockWaitSampleIntervalMs: 200,
      meter: telemetry.meter,
    });

    expect(pg.FakePool.instances).toHaveLength(4);
    await first.end();
    await second.end();
  });
});
