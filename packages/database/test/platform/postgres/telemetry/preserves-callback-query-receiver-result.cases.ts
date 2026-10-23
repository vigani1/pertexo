import { expect, it, vi } from 'vitest';
import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../../../../src/platform/pool/telemetry/create-pool.js';
import { pg, fakeMeter, poolAt, telemetryClient } from './fixture.js';

export function registerPreservesCallbackQueryReceiverResult(): void {
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
      { meter: telemetry.meter, monitorLockWaits: false, role: 'maintenance' },
    );

    await expect(pool.connect()).resolves.toBe(client);
    client.release(true);
    expect(originalRelease).toHaveBeenCalledWith(true);
    expect(
      telemetry.measurements.get(DATABASE_METRIC_NAME.poolCheckoutDuration),
    ).toEqual([
      expect.objectContaining({
        attributes: { outcome: 'success', pool_role: 'maintenance' },
      }),
    ]);

    await pool.end();
  });
}
