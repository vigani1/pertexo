import type { Meter } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  class FakePool {
    static instances: FakePool[] = [];
    static queryResults: { rows: { pid: number }[] }[] = [];
    readonly options: { max: number };
    readonly queries: string[] = [];
    readonly queryValues: unknown[][] = [];
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    private readonly listeners = new Map<
      string,
      ((value: unknown) => void)[]
    >();

    constructor(config: { max?: number }) {
      this.options = { max: config.max ?? 10 };
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

    connect(): Promise<never> {
      return Promise.reject(new Error('Fake pool connect is not implemented'));
    }

    query(
      query: string,
      values?: unknown[],
    ): Promise<{ rows: { pid: number }[] }> {
      this.queries.push(query);
      if (values !== undefined) this.queryValues.push(values);
      if (Array.isArray(values?.[0]) && (values[0] as unknown[]).length === 0)
        return Promise.resolve({ rows: [] });
      return Promise.resolve(FakePool.queryResults.shift() ?? { rows: [] });
    }

    end(): Promise<void> {
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

describe('PostgreSQL telemetry pool', () => {
  beforeEach(() => {
    pg.FakePool.instances.length = 0;
    pg.FakePool.queryResults.length = 0;
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
    await first.end();
    expect(pg.FakePool.instances[1]?.queries.length).toBeGreaterThan(0);
    await second.end();
  });
});
