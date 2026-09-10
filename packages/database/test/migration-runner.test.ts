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

  it('preserves an undefined migration rejection together with release failure', async () => {
    const releaseError = new Error('client release failed');
    const query = (sql: string) => {
      if (sql === 'reset role' || sql.startsWith('select pg_advisory_unlock'))
        return Promise.resolve({ rows: [] });
      // Deliberately exercise a hostile non-Error adapter rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(undefined);
    };
    postgres.connect.mockResolvedValue({
      query,
      release: () => {
        throw releaseError;
      },
    });

    const error = await migrateDatabase(config).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([undefined, releaseError]);
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it('preserves ordered reset, unlock, release, and pool cleanup failures', async () => {
    const migrationError = new Error('migration query failed');
    const resetError = new Error('reset role failed');
    const unlockError = new Error('advisory unlock failed');
    const releaseError = new Error('client release failed');
    const poolEndError = new Error('pool end failed');
    const query = vi.fn((sql: string) => {
      if (sql === 'reset role') return Promise.reject(resetError);
      if (sql.startsWith('select pg_advisory_unlock'))
        return Promise.reject(unlockError);
      return Promise.reject(migrationError);
    });
    postgres.connect.mockResolvedValue({
      query,
      release: () => {
        throw releaseError;
      },
    });
    postgres.end.mockRejectedValue(poolEndError);

    const error = await migrateDatabase(config).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      migrationError,
      resetError,
      unlockError,
      releaseError,
      poolEndError,
    ]);
    expect(query).toHaveBeenCalledWith('reset role');
    expect(query).toHaveBeenCalledWith('select pg_advisory_unlock($1)', [
      expect.any(Number),
    ]);
    expect(postgres.end).toHaveBeenCalledOnce();
  });
});
