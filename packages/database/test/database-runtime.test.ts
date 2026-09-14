import { beforeEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({
  create: vi.fn(),
  end: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/platform/postgres-telemetry.js', () => ({
  createDatabasePool: pool.create,
}));

import {
  acquireDatabasePool,
  createDatabaseRuntime,
} from '../src/platform/database-runtime.js';

const config = {
  connectionString: 'postgresql://runtime:password@db/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 5,
  ownerRole: 'owner',
  workerRuntimeRole: 'worker',
} as const;

describe('database process runtime', () => {
  beforeEach(() => {
    pool.create.mockReset();
    pool.end.mockClear();
    pool.create.mockReturnValue({ end: pool.end });
  });

  it('lends one process-owned pool without allowing repositories to end it', async () => {
    const runtime = createDatabaseRuntime(config, { role: 'api' });
    const first = acquireDatabasePool(config, runtime);
    const second = acquireDatabasePool({ ...config }, runtime);

    expect(pool.create).toHaveBeenCalledTimes(1);
    expect(first.pool).toBe(second.pool);
    await first.close();
    await second.close();
    expect(pool.end).not.toHaveBeenCalled();

    await runtime.close();
    await runtime.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('rejects a repository configured for a different database authority', async () => {
    const runtime = createDatabaseRuntime(config, { role: 'worker' });

    for (const changed of [
      { connectionString: 'postgresql://other:password@db/pertexo' },
      { connectionTimeoutMillis: config.connectionTimeoutMillis + 1 },
      { idleTimeoutMillis: config.idleTimeoutMillis + 1 },
      { max: config.max + 1 },
      { ownerRole: 'other_owner' },
      { workerRuntimeRole: 'other_worker' },
    ]) {
      expect(() =>
        acquireDatabasePool({ ...config, ...changed }, runtime),
      ).toThrow('Database runtime authority does not match repository config');
    }

    await runtime.close();
  });

  it('rejects a forged runtime before lending a pool', () => {
    const forged = Object.freeze({
      close: vi.fn().mockResolvedValue(undefined),
    });

    expect(() => acquireDatabasePool(config, forged)).toThrow(
      'Database runtime was not created by this package',
    );
    expect(pool.create).not.toHaveBeenCalled();
  });

  it('forbids repository acquisition after close starts', async () => {
    const end = Promise.withResolvers<undefined>();
    pool.end.mockReturnValueOnce(end.promise);
    const runtime = createDatabaseRuntime(config, { role: 'api' });

    const close = runtime.close();
    expect(() => acquireDatabasePool(config, runtime)).toThrow(
      'Database runtime is closed and cannot be acquired',
    );
    end.resolve(undefined);
    await close;
  });

  it.each(['reject', 'throw'] as const)(
    'memoizes a runtime close that %s',
    async (failureKind) => {
      const failure = new Error(`pool end ${failureKind}`);
      if (failureKind === 'reject') pool.end.mockRejectedValueOnce(failure);
      else
        pool.end.mockImplementationOnce(() => {
          throw failure;
        });
      const runtime = createDatabaseRuntime(config, { role: 'api' });

      const first = runtime.close();
      expect(runtime.close()).toBe(first);
      await expect(first).rejects.toBe(failure);
      await expect(runtime.close()).rejects.toBe(failure);
      expect(pool.end).toHaveBeenCalledOnce();
    },
  );

  it('retains explicit ownership for standalone repositories', async () => {
    const lease = acquireDatabasePool(config);

    expect(pool.create).toHaveBeenCalledTimes(1);
    await lease.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('memoizes standalone close including synchronous failure', async () => {
    const failure = new Error('standalone end failed');
    pool.end.mockImplementationOnce(() => {
      throw failure;
    });
    const lease = acquireDatabasePool(config);

    const first = lease.close();
    expect(lease.close()).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
