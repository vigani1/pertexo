import { expect, it, vi } from 'vitest';
import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../../../../src/platform/pool/telemetry/create-pool.js';
import { pg, fakeMeter, poolAt } from './fixture.js';

export function registerPreservesCallbackCheckoutReceiverValues(): void {
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
}
