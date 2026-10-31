import { expect, it, vi } from 'vitest';
import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../../../../src/platform/pool/telemetry/create-pool.js';
import { pg, fakeMeter, observableMeasurements, poolAt } from './fixture.js';

export function registerDoesNotMistakeUndefinedPool(): void {
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

  it('reports pool state by workload', async () => {
    const telemetry = fakeMeter();
    const first = createDatabasePool(
      { max: 4, user: 'pertexo_app' },
      { meter: telemetry.meter, monitorLockWaits: false, role: 'api' },
    );
    const second = createDatabasePool(
      { max: 6, user: 'pertexo_app' },
      { meter: telemetry.meter, monitorLockWaits: false, role: 'worker' },
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
      on: vi.fn(),
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
}
