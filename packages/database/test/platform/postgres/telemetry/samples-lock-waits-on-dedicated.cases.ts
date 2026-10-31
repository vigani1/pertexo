import { expect, it, vi } from 'vitest';
import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../../../../src/platform/pool/telemetry/create-pool.js';
import { pg, fakeMeter, observableMeasurements, poolAt } from './fixture.js';

export function registerSamplesLockWaitsOnDedicated(): void {
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
      on: vi.fn(),
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
}
