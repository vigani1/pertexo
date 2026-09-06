import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';

const postgres = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({
  Pool: class {
    connect = postgres.connect;
    end = postgres.end;
  },
}));

const config: MigrationConfig = {
  connectionString: 'postgresql://migration@example.test/database',
  apiRuntimeRole: 'api',
  dispatcherRole: 'dispatcher',
  maintenanceRole: 'maintenance',
  lifecycleCommandRole: 'lifecycle',
  operatorRole: 'operator',
  ownerRole: 'owner',
  workerRuntimeRole: 'worker',
};

describe('migration runner resource ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    postgres.connect.mockRejectedValue(new Error('database unavailable'));
    postgres.end.mockResolvedValue(undefined);
  });

  it.each([
    { lockTimeoutMs: 99 },
    { lockTimeoutMs: Number.NaN },
    { statementTimeoutMs: 999 },
    { statementTimeoutMs: 1_000.5 },
  ])(
    'rejects invalid options before accessing PostgreSQL: %j',
    async (options) => {
      await expect(
        migrateDatabase(config, undefined, options),
      ).rejects.toBeInstanceOf(TypeError);
      expect(postgres.connect).not.toHaveBeenCalled();
    },
  );

  it('closes its pool when PostgreSQL connection acquisition fails', async () => {
    const unavailable = new Error('database unavailable');
    postgres.connect.mockRejectedValue(unavailable);
    await expect(migrateDatabase(config)).rejects.toBe(unavailable);
    expect(postgres.end).toHaveBeenCalledOnce();
  });
});
