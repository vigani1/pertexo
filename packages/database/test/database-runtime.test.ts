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

    expect(() =>
      acquireDatabasePool({ ...config, max: config.max + 1 }, runtime),
    ).toThrow('Database runtime authority does not match repository config');

    await runtime.close();
  });

  it('retains explicit ownership for standalone repositories', async () => {
    const lease = acquireDatabasePool(config);

    expect(pool.create).toHaveBeenCalledTimes(1);
    await lease.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
